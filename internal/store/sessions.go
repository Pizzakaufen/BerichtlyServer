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
	RevokeLogoutAll         RevokeReason = "LOGOUT_ALL"
	RevokeRefreshTokenReuse RevokeReason = "REFRESH_TOKEN_REUSE"
	RevokeDeviceRemoved     RevokeReason = "DEVICE_REMOVED"
	RevokeSessionRemoved    RevokeReason = "SESSION_REMOVED"
	RevokePasswordChanged   RevokeReason = "PASSWORD_CHANGED"
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
	DeviceRef     *uuid.UUID
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
		SELECT t.id, t.session_id, s.user_id, s.device_ref,
		       (t.used_at IS NOT NULL),
		       (t.expires_at <= now()),
		       (s.revoked_at IS NULL AND s.expires_at > now()),
		       (u.status = 'ACTIVE')
		FROM refresh_tokens t
		JOIN sessions s ON s.id = t.session_id
		JOIN users u ON u.id = s.user_id
		WHERE t.token_hash = $1
		FOR UPDATE OF t, s`, hash).
		Scan(&r.TokenID, &r.SessionID, &r.UserID, &r.DeviceRef, &r.Used, &r.Expired, &r.SessionActive, &r.UserActive)
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

// RevokeOwnSession widerruft eine Sitzung des Benutzers. false = existiert nicht/gehört anderem Konto.
func RevokeOwnSession(ctx context.Context, q Querier, userID, sessionID uuid.UUID, reason RevokeReason) (bool, error) {
	tag, err := q.Exec(ctx, `UPDATE sessions SET revoked_at = COALESCE(revoked_at, now()),
			revoke_reason = COALESCE(revoke_reason, $1)
		WHERE id = $2 AND user_id = $3 AND expires_at > now()`, string(reason), sessionID, userID)
	return tag.RowsAffected() > 0, err
}

// RevokeAllSessions widerruft alle Sitzungen eines Kontos, optional außer einer.
func RevokeAllSessions(ctx context.Context, q Querier, userID uuid.UUID, except *uuid.UUID, reason RevokeReason) (int64, error) {
	tag, err := q.Exec(ctx, `UPDATE sessions SET revoked_at = now(), revoke_reason = $1
		WHERE user_id = $2 AND revoked_at IS NULL AND ($3::uuid IS NULL OR id <> $3)`, string(reason), userID, except)
	return tag.RowsAffected(), err
}

func RevokeSessionsForDevice(ctx context.Context, q Querier, userID, deviceRef uuid.UUID, reason RevokeReason) error {
	_, err := q.Exec(ctx, `UPDATE sessions SET revoked_at = now(), revoke_reason = $1
		WHERE user_id = $2 AND device_ref = $3 AND revoked_at IS NULL`, string(reason), userID, deviceRef)
	return err
}

// BindSessionToDevice ordnet eine Sitzung (z. B. nach Login ohne Geräteangabe) einem Gerät zu.
func BindSessionToDevice(ctx context.Context, q Querier, sessionID, deviceRef uuid.UUID) error {
	_, err := q.Exec(ctx, `UPDATE sessions SET device_ref = $1 WHERE id = $2`, deviceRef, sessionID)
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

// TouchActivity aktualisiert "zuletzt aktiv" von Sitzung und Gerät höchstens einmal pro Minute,
// damit nicht jeder Request einen Schreibvorgang auslöst.
func TouchActivity(ctx context.Context, q Querier, sessionID uuid.UUID, deviceRef *uuid.UUID) error {
	if _, err := q.Exec(ctx, `UPDATE sessions SET last_used_at = now()
		WHERE id = $1 AND last_used_at < now() - interval '1 minute'`, sessionID); err != nil {
		return err
	}
	if deviceRef != nil {
		_, err := q.Exec(ctx, `UPDATE devices SET last_seen_at = now()
			WHERE id = $1 AND last_seen_at < now() - interval '1 minute'`, *deviceRef)
		return err
	}
	return nil
}

// ListActiveSessions liefert die aktiven Sitzungen eines Kontos (paginiert).
func ListActiveSessions(ctx context.Context, q Querier, userID uuid.UUID, limit, offset int) ([]model.Session, int64, error) {
	var total int64
	if err := q.QueryRow(ctx, `SELECT count(*) FROM sessions
		WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()`, userID).Scan(&total); err != nil {
		return nil, 0, err
	}
	items, err := queryAll(ctx, q, func(row interface{ Scan(...any) error }) (*model.Session, error) {
		var s model.Session
		err := row.Scan(&s.ID, &s.DeviceID, &s.DeviceName, &s.CreatedAt, &s.LastUsedAt, &s.ExpiresAt)
		return &s, err
	}, `SELECT s.id, d.device_id, d.name, s.created_at, s.last_used_at, s.expires_at
		FROM sessions s LEFT JOIN devices d ON d.id = s.device_ref
		WHERE s.user_id = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
		ORDER BY s.last_used_at DESC, s.id LIMIT $2 OFFSET $3`, userID, limit, offset)
	return items, total, err
}

// ---------------------------------------------------------------------------
// Geräte
// ---------------------------------------------------------------------------

// UpsertDevice legt das Gerät an oder aktualisiert Name/Version und liefert die interne Referenz.
// Ein zuvor abgemeldetes Gerät wird durch eine erneute Anmeldung wieder aktiv.
func UpsertDevice(ctx context.Context, q Querier, userID uuid.UUID, info model.DeviceInfo) (uuid.UUID, error) {
	var ref uuid.UUID
	err := q.QueryRow(ctx, `
		INSERT INTO devices (id, user_id, device_id, name, platform, os_version, app_version)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		ON CONFLICT (user_id, device_id) DO UPDATE SET
			name = EXCLUDED.name, platform = EXCLUDED.platform, os_version = EXCLUDED.os_version,
			app_version = EXCLUDED.app_version, last_seen_at = now(), revoked_at = NULL
		RETURNING id`, uuid.New(), userID, info.DeviceID, info.Name, info.Platform, info.OSVersion, info.AppVersion).Scan(&ref)
	return ref, err
}

// DeviceUpdate enthält änderbare Geräteangaben (nil = unverändert).
type DeviceUpdate struct {
	Name, Platform, OSVersion, AppVersion *string
}

// UpdateDevice ändert Angaben eines eigenen, nicht abgemeldeten Geräts. false = nicht gefunden.
func UpdateDevice(ctx context.Context, q Querier, userID, deviceID uuid.UUID, u DeviceUpdate) (bool, error) {
	tag, err := q.Exec(ctx, `UPDATE devices SET
			name = COALESCE($1, name), platform = COALESCE($2, platform),
			os_version = COALESCE($3, os_version), app_version = COALESCE($4, app_version)
		WHERE user_id = $5 AND device_id = $6 AND revoked_at IS NULL`,
		u.Name, u.Platform, u.OSVersion, u.AppVersion, userID, deviceID)
	return tag.RowsAffected() > 0, err
}

// RevokeDevice meldet ein Gerät ab (Datensatz bleibt für die Nachvollziehbarkeit erhalten).
func RevokeDevice(ctx context.Context, q Querier, userID, ref uuid.UUID) error {
	_, err := q.Exec(ctx, `UPDATE devices SET revoked_at = COALESCE(revoked_at, now()) WHERE user_id = $1 AND id = $2`, userID, ref)
	return err
}

const deviceSelect = `
	SELECT d.id, d.user_id, d.device_id, d.name, d.platform, d.os_version, d.app_version, d.created_at,
	       d.last_seen_at, d.revoked_at, d.last_pull_at, d.last_pull_cursor, d.last_push_at,
	       d.sync_status, d.last_sync_started_at, d.last_successful_sync_at, d.last_successful_cursor,
	       d.last_failed_sync_at, d.last_sync_error_code, d.unresolved_conflicts,
	       (SELECT count(*) FROM sessions s
	         WHERE s.device_ref = d.id AND s.revoked_at IS NULL AND s.expires_at > now())
	FROM devices d`

func scanDevice(row interface{ Scan(...any) error }) (*model.Device, error) {
	var d model.Device
	var status string
	err := row.Scan(&d.Ref, &d.UserID, &d.DeviceID, &d.Name, &d.Platform, &d.OSVersion, &d.AppVersion,
		&d.CreatedAt, &d.LastSeenAt, &d.RevokedAt, &d.LastPullAt, &d.LastPullCursor, &d.LastPushAt,
		&status, &d.LastSyncStartedAt, &d.LastSuccessfulSyncAt, &d.LastSuccessfulCursor,
		&d.LastFailedSyncAt, &d.LastSyncErrorCode, &d.UnresolvedConflicts, &d.ActiveSessions)
	if err != nil {
		return nil, err
	}
	d.SyncStatus = model.SyncStatus(status)
	return &d, nil
}

// ListDevices liefert die Geräte eines Kontos (paginiert); abgemeldete nur auf Wunsch.
func ListDevices(ctx context.Context, q Querier, userID uuid.UUID, includeRevoked bool, limit, offset int) ([]model.Device, int64, error) {
	var total int64
	if err := q.QueryRow(ctx, `SELECT count(*) FROM devices d WHERE d.user_id = $1 AND ($2 OR d.revoked_at IS NULL)`,
		userID, includeRevoked).Scan(&total); err != nil {
		return nil, 0, err
	}
	items, err := queryAll(ctx, q, scanDevice, deviceSelect+` WHERE d.user_id = $1 AND ($2 OR d.revoked_at IS NULL)
		ORDER BY d.last_seen_at DESC, d.id LIMIT $3 OFFSET $4`, userID, includeRevoked, limit, offset)
	return items, total, err
}

func FindDeviceByRef(ctx context.Context, q Querier, userID, ref uuid.UUID) (*model.Device, error) {
	return nilIfNoRows(scanDevice(q.QueryRow(ctx, deviceSelect+` WHERE d.user_id = $1 AND d.id = $2`, userID, ref)))
}

func FindDeviceByDeviceID(ctx context.Context, q Querier, userID, deviceID uuid.UUID) (*model.Device, error) {
	return nilIfNoRows(scanDevice(q.QueryRow(ctx, deviceSelect+` WHERE d.user_id = $1 AND d.device_id = $2`, userID, deviceID)))
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

// MarkSyncStarted vermerkt den Beginn eines Synchronisationsvorgangs (ändert den Status nicht).
func MarkSyncStarted(ctx context.Context, q Querier, ref uuid.UUID) error {
	_, err := q.Exec(ctx, `UPDATE devices SET last_sync_started_at = now(), last_seen_at = now() WHERE id = $1`, ref)
	return err
}

// CompleteSync speichert das vom Gerät gemeldete Ergebnis eines Synchronisationsvorgangs.
// Nur SUCCESS bzw. CONFLICT setzen den Zeitpunkt der letzten erfolgreichen Synchronisierung;
// ein fehlgeschlagener Vorgang wird nie als erfolgreich gespeichert.
func CompleteSync(ctx context.Context, q Querier, ref uuid.UUID, status model.SyncStatus, cursor *int64, conflicts int, errorCode *string) error {
	var err error
	if status == model.SyncFailed {
		_, err = q.Exec(ctx, `UPDATE devices SET sync_status = 'FAILED', last_failed_sync_at = now(),
			last_sync_error_code = $1, last_seen_at = now() WHERE id = $2`, errorCode, ref)
	} else {
		_, err = q.Exec(ctx, `UPDATE devices SET sync_status = $1, last_successful_sync_at = now(),
			last_successful_cursor = $2, unresolved_conflicts = $3, last_sync_error_code = NULL, last_seen_at = now()
			WHERE id = $4`, string(status), cursor, conflicts, ref)
	}
	return err
}

// ---------------------------------------------------------------------------
// Sicherheitsereignisse
// ---------------------------------------------------------------------------

// Ereignistypen (stabil, Teil der API).
const (
	EventRegistered           = "REGISTERED"
	EventLoginSucceeded       = "LOGIN_SUCCEEDED"
	EventLoginFailed          = "LOGIN_FAILED"
	EventLoginUnknownAccount  = "LOGIN_FAILED_UNKNOWN_ACCOUNT"
	EventAccountLocked        = "ACCOUNT_LOCKED"
	EventLogout               = "LOGOUT"
	EventLogoutAll            = "LOGOUT_ALL"
	EventRefreshTokenReuse    = "REFRESH_TOKEN_REUSE"
	EventSessionRevoked       = "SESSION_REVOKED"
	EventDeviceRevoked        = "DEVICE_REVOKED"
	EventPasswordChanged      = "PASSWORD_CHANGED"
	EventPasswordChangeFailed = "PASSWORD_CHANGE_FAILED"
)

// RecordSecurityEvent speichert ein technisches Ereignis ohne Inhalte (userID darf nil sein).
func RecordSecurityEvent(ctx context.Context, q Querier, userID *uuid.UUID, eventType string, sessionID, deviceRef *uuid.UUID) error {
	_, err := q.Exec(ctx, `INSERT INTO security_events (user_id, event_type, session_id, device_ref)
		VALUES ($1, $2, $3, $4)`, userID, eventType, sessionID, deviceRef)
	return err
}

func ListSecurityEvents(ctx context.Context, q Querier, userID uuid.UUID, limit, offset int) ([]model.SecurityEvent, int64, error) {
	var total int64
	if err := q.QueryRow(ctx, `SELECT count(*) FROM security_events WHERE user_id = $1`, userID).Scan(&total); err != nil {
		return nil, 0, err
	}
	items, err := queryAll(ctx, q, func(row interface{ Scan(...any) error }) (*model.SecurityEvent, error) {
		var e model.SecurityEvent
		err := row.Scan(&e.ID, &e.Type, &e.SessionID, &e.DeviceID, &e.CreatedAt)
		return &e, err
	}, `SELECT e.id, e.event_type, e.session_id, d.device_id, e.created_at
		FROM security_events e LEFT JOIN devices d ON d.id = e.device_ref
		WHERE e.user_id = $1 ORDER BY e.created_at DESC, e.id DESC LIMIT $2 OFFSET $3`, userID, limit, offset)
	return items, total, err
}
