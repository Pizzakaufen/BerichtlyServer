package store

import (
	"context"
	"encoding/json"
	"strconv"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// ---------------------------------------------------------------------------
// Idempotenz von Synchronisationsoperationen
// ---------------------------------------------------------------------------

// StoredOperation ist eine bereits verarbeitete Operation.
type StoredOperation struct {
	EntityType  string
	EntityID    uuid.UUID
	RequestHash []byte
	Result      json.RawMessage
}

func FindOperation(ctx context.Context, q Querier, userID, operationID uuid.UUID) (*StoredOperation, error) {
	var o StoredOperation
	err := q.QueryRow(ctx, `SELECT entity_type, entity_id, request_hash, result FROM sync_operations
		WHERE user_id = $1 AND operation_id = $2`, userID, operationID).
		Scan(&o.EntityType, &o.EntityID, &o.RequestHash, &o.Result)
	if IsNoRows(err) {
		return nil, nil
	}
	return &o, err
}

func InsertOperation(ctx context.Context, q Querier, userID, operationID uuid.UUID, deviceRef *uuid.UUID,
	entityType string, entityID uuid.UUID, requestHash []byte, result any) error {
	data, err := json.Marshal(result)
	if err != nil {
		return err
	}
	_, err = q.Exec(ctx, `INSERT INTO sync_operations (user_id, operation_id, device_ref, entity_type, entity_id, request_hash, result)
		VALUES ($1, $2, $3, $4, $5, $6, $7)`, userID, operationID, deviceRef, entityType, entityID, requestHash, data)
	return err
}

// ---------------------------------------------------------------------------
// Serverzustand
// ---------------------------------------------------------------------------

const keyMinValidCursor = "sync_min_valid_cursor"

// MinValidCursor ist die Untergrenze gültiger Sync-Cursor. Ältere Cursor können Löschungen
// verpasst haben, deren Tombstones bereits bereinigt wurden; das Gerät muss neu synchronisieren.
func MinValidCursor(ctx context.Context, q Querier) (int64, error) {
	var raw string
	err := q.QueryRow(ctx, `SELECT value FROM server_state WHERE key = $1`, keyMinValidCursor).Scan(&raw)
	if IsNoRows(err) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	return strconv.ParseInt(raw, 10, 64)
}

// ---------------------------------------------------------------------------
// Wartung
// ---------------------------------------------------------------------------

// maintenanceLockID verhindert parallele Wartungsläufe (mehrere Instanzen, CLI + Server).
const maintenanceLockID = 726_174_520_032

type Retention struct {
	Tombstones     time.Duration
	Operations     time.Duration
	SecurityEvents time.Duration
	// Abgelaufene oder widerrufene Sitzungen (inkl. Refresh Tokens) werden danach entfernt.
	Sessions time.Duration
}

type MaintenanceResult struct {
	Skipped              bool  `json:"skipped"` // läuft bereits an anderer Stelle
	TombstonesPurged     int64 `json:"tombstonesPurged"`
	MinValidCursor       int64 `json:"minValidCursor"`
	OperationsPurged     int64 `json:"operationsPurged"`
	SecurityEventsPurged int64 `json:"securityEventsPurged"`
	SessionsPurged       int64 `json:"sessionsPurged"`
	RefreshTokensPurged  int64 `json:"refreshTokensPurged"`
}

// RunMaintenance entfernt Daten, deren Aufbewahrungsfrist abgelaufen ist. Alles in einer
// Transaktion; Tombstones werden nur zusammen mit der Anhebung der Cursor-Untergrenze gelöscht,
// damit kein Gerät eine Löschung unbemerkt verpasst.
func (db *DB) RunMaintenance(ctx context.Context, r Retention) (MaintenanceResult, error) {
	var res MaintenanceResult
	err := db.Tx(ctx, func(tx pgx.Tx) error {
		var locked bool
		if err := tx.QueryRow(ctx, `SELECT pg_try_advisory_xact_lock($1)`, maintenanceLockID).Scan(&locked); err != nil {
			return err
		}
		if !locked {
			res.Skipped = true
			return nil
		}
		secs := func(d time.Duration) float64 { return d.Seconds() }

		// Tombstones: höchste gelöschte Änderungsnummer merken, dann löschen.
		var maxDaily, maxWeekly int64
		if err := tx.QueryRow(ctx, `WITH d AS (DELETE FROM daily_reports
				WHERE deleted_at IS NOT NULL AND deleted_at < now() - make_interval(secs => $1) RETURNING change_seq)
			SELECT count(*), COALESCE(MAX(change_seq), 0) FROM d`, secs(r.Tombstones)).Scan(&res.TombstonesPurged, &maxDaily); err != nil {
			return err
		}
		var weeklyCount int64
		if err := tx.QueryRow(ctx, `WITH d AS (DELETE FROM weekly_reports
				WHERE deleted_at IS NOT NULL AND deleted_at < now() - make_interval(secs => $1) RETURNING change_seq)
			SELECT count(*), COALESCE(MAX(change_seq), 0) FROM d`, secs(r.Tombstones)).Scan(&weeklyCount, &maxWeekly); err != nil {
			return err
		}
		res.TombstonesPurged += weeklyCount
		current, err := MinValidCursor(ctx, tx)
		if err != nil {
			return err
		}
		res.MinValidCursor = max(current, maxDaily, maxWeekly)
		if res.MinValidCursor > current {
			if _, err := tx.Exec(ctx, `INSERT INTO server_state (key, value) VALUES ($1, $2)
				ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
				keyMinValidCursor, strconv.FormatInt(res.MinValidCursor, 10)); err != nil {
				return err
			}
		}

		tag, err := tx.Exec(ctx, `DELETE FROM sync_operations WHERE created_at < now() - make_interval(secs => $1)`, secs(r.Operations))
		if err != nil {
			return err
		}
		res.OperationsPurged = tag.RowsAffected()
		if tag, err = tx.Exec(ctx, `DELETE FROM security_events WHERE created_at < now() - make_interval(secs => $1)`, secs(r.SecurityEvents)); err != nil {
			return err
		}
		res.SecurityEventsPurged = tag.RowsAffected()
		if tag, err = tx.Exec(ctx, `DELETE FROM refresh_tokens t USING sessions s
			WHERE s.id = t.session_id AND s.revoked_at IS NULL AND s.expires_at > now()
			  AND COALESCE(t.used_at, t.expires_at) < now() - make_interval(secs => $1)`, secs(r.Sessions)); err != nil {
			return err
		}
		res.RefreshTokensPurged = tag.RowsAffected()
		if tag, err = tx.Exec(ctx, `DELETE FROM sessions
			WHERE COALESCE(revoked_at, expires_at) < now() - make_interval(secs => $1)`, secs(r.Sessions)); err != nil {
			return err
		}
		res.SessionsPurged = tag.RowsAffected()
		return nil
	})
	return res, err
}
