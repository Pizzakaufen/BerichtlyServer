package store

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"

	"berichtly-server/internal/model"
)

type RevokeReason string

const (
	RevokeLogout            RevokeReason = "LOGOUT"
	RevokeRefreshTokenReuse RevokeReason = "REFRESH_TOKEN_REUSE"
	RevokeDeviceRemoved     RevokeReason = "DEVICE_REMOVED"
)

func CreateSession(ctx context.Context, q Querier, sessionID, userID uuid.UUID, deviceRef *uuid.UUID, maxLifetime time.Duration) error {
	_, err := q.Exec(ctx, `INSERT INTO sessions (id, user_id, device_ref, expires_at)
		VALUES ($1, $2, $3, now() + make_interval(secs => $4))`, sessionID, userID, deviceRef, maxLifetime.Seconds())
	return err
}

// InsertRefreshToken speichert den Hash eines Refresh Tokens. Es läuft spätestens mit der Sitzung ab.
func InsertRefreshToken(ctx context.Context, q Querier, sessionID uuid.UUID, hash []byte, ttl time.Duration) (time.Time, error) {
	var expires time.Time
	err := q.QueryRow(ctx, `
		INSERT INTO refresh_tokens (id, session_id, token_hash, expires_at)
		SELECT $1, s.id, $2, LEAST(now() + make_interval(secs => $3), s.expires_at)
		FROM sessions s WHERE s.id = $4
		RETURNING expires_at`, uuid.New(), hash, ttl.Seconds(), sessionID).Scan(&expires)
	if IsNoRows(err) {
		return time.Time{}, fmt.Errorf("Sitzung %s existiert nicht", sessionID)
	}
	return expires, err
}

type RefreshTokenRow struct {
	TokenID       uuid.UUID
	SessionID     uuid.UUID
	UserID        uuid.UUID
	Used          bool
	Expired       bool
	SessionActive bool
	UserActive    bool
}

// FindRefreshTokenForUpdate lädt ein Refresh Token und sperrt Token und Sitzung, damit parallele
// Erneuerungen sicher erkannt werden. nil = unbekannt.
func FindRefreshTokenForUpdate(ctx context.Context, q Querier, hash []byte) (*RefreshTokenRow, error) {
	var r RefreshTokenRow
	err := q.QueryRow(ctx, `
		SELECT t.id, t.session_id, s.user_id,
		       (t.used_at IS NOT NULL),
		       (t.expires_at <= now()),
		       (s.revoked_at IS NULL AND s.expires_at > now()),
		       (u.status = 'ACTIVE')
		FROM refresh_tokens t
		JOIN sessions s ON s.id = t.session_id
		JOIN users u ON u.id = s.user_id
		WHERE t.token_hash = $1
		FOR UPDATE OF t, s`, hash).
		Scan(&r.TokenID, &r.SessionID, &r.UserID, &r.Used, &r.Expired, &r.SessionActive, &r.UserActive)
	if IsNoRows(err) {
		return nil, nil
	}
	return &r, err
}

func MarkRefreshTokenUsed(ctx context.Context, q Querier, tokenID, sessionID uuid.UUID) error {
	if _, err := q.Exec(ctx, `UPDATE refresh_tokens SET used_at = now() WHERE id = $1`, tokenID); err != nil {
		return err
	}
	_, err := q.Exec(ctx, `UPDATE sessions SET last_used_at = now() WHERE id = $1`, sessionID)
	return err
}

func RevokeSession(ctx context.Context, q Querier, sessionID uuid.UUID, reason RevokeReason) error {
	_, err := q.Exec(ctx, `UPDATE sessions SET revoked_at = now(), revoke_reason = $1
		WHERE id = $2 AND revoked_at IS NULL`, string(reason), sessionID)
	return err
}

func RevokeSessionsForDevice(ctx context.Context, q Querier, userID, deviceRef uuid.UUID, reason RevokeReason) error {
	_, err := q.Exec(ctx, `UPDATE sessions SET revoked_at = now(), revoke_reason = $1
		WHERE user_id = $2 AND device_ref = $3 AND revoked_at IS NULL`, string(reason), userID, deviceRef)
	return err
}

// ActiveSession ist eine gültige Sitzung eines aktiven Kontos.
type ActiveSession struct {
	SessionID uuid.UUID
	UserID    uuid.UUID
	DeviceRef *uuid.UUID
}

// FindActiveSession wird bei jedem authentifizierten Request geprüft (Logout wirkt sofort).
func FindActiveSession(ctx context.Context, q Querier, sessionID, userID uuid.UUID) (*ActiveSession, error) {
	var s ActiveSession
	err := q.QueryRow(ctx, `
		SELECT s.id, s.user_id, s.device_ref
		FROM sessions s JOIN users u ON u.id = s.user_id
		WHERE s.id = $1 AND s.user_id = $2 AND s.revoked_at IS NULL AND s.expires_at > now()
		  AND u.status = 'ACTIVE'`, sessionID, userID).Scan(&s.SessionID, &s.UserID, &s.DeviceRef)
	if IsNoRows(err) {
		return nil, nil
	}
	return &s, err
}

// ---------------------------------------------------------------------------
// Geräte
// ---------------------------------------------------------------------------

// UpsertDevice legt das Gerät an oder aktualisiert Name/Version und liefert die interne Referenz.
func UpsertDevice(ctx context.Context, q Querier, userID uuid.UUID, info model.DeviceInfo) (uuid.UUID, error) {
	var ref uuid.UUID
	err := q.QueryRow(ctx, `
		INSERT INTO devices (id, user_id, device_id, name, platform, app_version)
		VALUES ($1, $2, $3, $4, $5, $6)
		ON CONFLICT (user_id, device_id) DO UPDATE SET
			name = EXCLUDED.name, platform = EXCLUDED.platform,
			app_version = EXCLUDED.app_version, last_seen_at = now()
		RETURNING id`, uuid.New(), userID, info.DeviceID, info.Name, info.Platform, info.AppVersion).Scan(&ref)
	return ref, err
}

const deviceSelect = `
	SELECT d.id, d.user_id, d.device_id, d.name, d.platform, d.app_version, d.created_at, d.last_seen_at,
	       d.last_pull_at, d.last_pull_cursor, d.last_push_at,
	       (SELECT count(*) FROM sessions s
	         WHERE s.device_ref = d.id AND s.revoked_at IS NULL AND s.expires_at > now())
	FROM devices d`

func scanDevice(row interface{ Scan(...any) error }) (*model.Device, error) {
	var d model.Device
	err := row.Scan(&d.Ref, &d.UserID, &d.DeviceID, &d.Name, &d.Platform, &d.AppVersion, &d.CreatedAt,
		&d.LastSeenAt, &d.LastPullAt, &d.LastPullCursor, &d.LastPushAt, &d.ActiveSessions)
	if err != nil {
		return nil, err
	}
	return &d, nil
}

func ListDevices(ctx context.Context, q Querier, userID uuid.UUID) ([]model.Device, error) {
	rows, err := q.Query(ctx, deviceSelect+` WHERE d.user_id = $1 ORDER BY d.last_seen_at DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []model.Device{}
	for rows.Next() {
		d, err := scanDevice(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, *d)
	}
	return result, rows.Err()
}

func FindDeviceByRef(ctx context.Context, q Querier, userID, ref uuid.UUID) (*model.Device, error) {
	d, err := scanDevice(q.QueryRow(ctx, deviceSelect+` WHERE d.user_id = $1 AND d.id = $2`, userID, ref))
	if IsNoRows(err) {
		return nil, nil
	}
	return d, err
}

func FindDeviceByDeviceID(ctx context.Context, q Querier, userID, deviceID uuid.UUID) (*model.Device, error) {
	d, err := scanDevice(q.QueryRow(ctx, deviceSelect+` WHERE d.user_id = $1 AND d.device_id = $2`, userID, deviceID))
	if IsNoRows(err) {
		return nil, nil
	}
	return d, err
}

func MarkDevicePull(ctx context.Context, q Querier, ref uuid.UUID, cursor int64) error {
	_, err := q.Exec(ctx, `UPDATE devices SET last_pull_at = now(), last_pull_cursor = $1, last_seen_at = now()
		WHERE id = $2`, cursor, ref)
	return err
}

func MarkDevicePush(ctx context.Context, q Querier, ref uuid.UUID) error {
	_, err := q.Exec(ctx, `UPDATE devices SET last_push_at = now(), last_seen_at = now() WHERE id = $1`, ref)
	return err
}
