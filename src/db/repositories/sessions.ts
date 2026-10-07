import { randomUUID } from 'node:crypto';
import type { Device, DeviceInfo, SecurityEvent, Session, SyncStatus } from '../../domain/models.ts';
import type { Queryable } from '../pool.ts';

export type RevokeReason = 'LOGOUT' | 'LOGOUT_ALL' | 'REFRESH_TOKEN_REUSE' | 'DEVICE_REMOVED' | 'SESSION_REMOVED'
  | 'PASSWORD_CHANGED';

export async function createSession(q: Queryable, sessionId: string, userId: string, deviceRef: string | null,
  maxLifetimeSec: number) {
  await q.query(`INSERT INTO sessions (id, user_id, device_ref, expires_at)
    VALUES ($1, $2, $3, now() + make_interval(secs => $4))`, [sessionId, userId, deviceRef, maxLifetimeSec]);
}

/** Speichert den Hash eines Refresh Tokens. Es läuft spätestens mit der Sitzung ab. */
export async function insertRefreshToken(q: Queryable, sessionId: string, hash: Buffer, ttlSec: number): Promise<Date> {
  const { rows } = await q.query<{ expires_at: Date }>(`
    INSERT INTO refresh_tokens (id, session_id, token_hash, expires_at)
    SELECT $1, s.id, $2, LEAST(now() + make_interval(secs => $3), s.expires_at)
    FROM sessions s WHERE s.id = $4
    RETURNING expires_at`, [randomUUID(), hash, ttlSec, sessionId]);
  if (!rows[0]) throw new Error(`Sitzung ${sessionId} existiert nicht`);
  return rows[0].expires_at;
}

export interface RefreshTokenRow {
  tokenId: string;
  sessionId: string;
  userId: string;
  deviceRef: string | null;
  used: boolean;
  expired: boolean;
  sessionActive: boolean;
  userActive: boolean;
}

/** Lädt ein Refresh Token und sperrt Token und Sitzung (sichere Erkennung paralleler Erneuerungen). */
export async function findRefreshTokenForUpdate(q: Queryable, hash: Buffer): Promise<RefreshTokenRow | null> {
  const { rows } = await q.query(`
    SELECT t.id AS token_id, t.session_id, s.user_id, s.device_ref,
           (t.used_at IS NOT NULL) AS used,
           (t.expires_at <= now()) AS expired,
           (s.revoked_at IS NULL AND s.expires_at > now()) AS session_active,
           (u.status = 'ACTIVE') AS user_active
    FROM refresh_tokens t
    JOIN sessions s ON s.id = t.session_id
    JOIN users u ON u.id = s.user_id
    WHERE t.token_hash = $1
    FOR UPDATE OF t, s`, [hash]);
  const r = rows[0];
  return r ? {
    tokenId: r.token_id, sessionId: r.session_id, userId: r.user_id, deviceRef: r.device_ref, used: r.used,
    expired: r.expired, sessionActive: r.session_active, userActive: r.user_active,
  } : null;
}

export async function markRefreshTokenUsed(q: Queryable, tokenId: string, sessionId: string) {
  await q.query('UPDATE refresh_tokens SET used_at = now() WHERE id = $1', [tokenId]);
  await q.query('UPDATE sessions SET last_used_at = now() WHERE id = $1', [sessionId]);
}

export async function revokeSession(q: Queryable, sessionId: string, reason: RevokeReason) {
  await q.query(`UPDATE sessions SET revoked_at = now(), revoke_reason = $1
    WHERE id = $2 AND revoked_at IS NULL`, [reason, sessionId]);
}

/** Widerruft eine eigene Sitzung; false = existiert nicht oder gehört einem anderen Konto. */
export async function revokeOwnSession(q: Queryable, userId: string, sessionId: string, reason: RevokeReason) {
  const res = await q.query(`UPDATE sessions SET revoked_at = COALESCE(revoked_at, now()),
      revoke_reason = COALESCE(revoke_reason, $1)
    WHERE id = $2 AND user_id = $3 AND expires_at > now()`, [reason, sessionId, userId]);
  return (res.rowCount ?? 0) > 0;
}

/** Widerruft alle Sitzungen eines Kontos, optional außer einer. */
export async function revokeAllSessions(q: Queryable, userId: string, except: string | null, reason: RevokeReason) {
  const res = await q.query(`UPDATE sessions SET revoked_at = now(), revoke_reason = $1
    WHERE user_id = $2 AND revoked_at IS NULL AND ($3::uuid IS NULL OR id <> $3)`, [reason, userId, except]);
  return res.rowCount ?? 0;
}

export async function revokeSessionsForDevice(q: Queryable, userId: string, deviceRef: string, reason: RevokeReason) {
  await q.query(`UPDATE sessions SET revoked_at = now(), revoke_reason = $1
    WHERE user_id = $2 AND device_ref = $3 AND revoked_at IS NULL`, [reason, userId, deviceRef]);
}

export async function bindSessionToDevice(q: Queryable, sessionId: string, deviceRef: string) {
  await q.query('UPDATE sessions SET device_ref = $1 WHERE id = $2', [deviceRef, sessionId]);
}

export interface ActiveSession {
  sessionId: string;
  userId: string;
  deviceRef: string | null;
}

/** Wird bei jedem authentifizierten Request geprüft (Logout und Sperren wirken sofort). */
export async function findActiveSession(q: Queryable, sessionId: string, userId: string): Promise<ActiveSession | null> {
  const { rows } = await q.query(`
    SELECT s.id, s.user_id, s.device_ref
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.id = $1 AND s.user_id = $2 AND s.revoked_at IS NULL AND s.expires_at > now()
      AND u.status = 'ACTIVE'`, [sessionId, userId]);
  return rows[0] ? { sessionId: rows[0].id, userId: rows[0].user_id, deviceRef: rows[0].device_ref } : null;
}

/** "Zuletzt aktiv" von Sitzung und Gerät höchstens einmal pro Minute aktualisieren. */
export async function touchActivity(q: Queryable, sessionId: string, deviceRef: string | null) {
  await q.query(`UPDATE sessions SET last_used_at = now()
    WHERE id = $1 AND last_used_at < now() - interval '1 minute'`, [sessionId]);
  if (deviceRef) {
    await q.query(`UPDATE devices SET last_seen_at = now()
      WHERE id = $1 AND last_seen_at < now() - interval '1 minute'`, [deviceRef]);
  }
}

export async function listActiveSessions(q: Queryable, userId: string, limit: number, offset: number) {
  const total = await q.query<{ n: number }>(`SELECT count(*) AS n FROM sessions
    WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()`, [userId]);
  const { rows } = await q.query(`SELECT s.id, d.device_id, d.name, s.created_at, s.last_used_at, s.expires_at
    FROM sessions s LEFT JOIN devices d ON d.id = s.device_ref
    WHERE s.user_id = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
    ORDER BY s.last_used_at DESC, s.id LIMIT $2 OFFSET $3`, [userId, limit, offset]);
  const items: Session[] = rows.map((r) => ({
    id: r.id, deviceId: r.device_id, deviceName: r.name, createdAt: r.created_at, lastUsedAt: r.last_used_at,
    expiresAt: r.expires_at,
  }));
  return { items, total: total.rows[0].n };
}

// ---------------------------------------------------------------------------
// Geräte
// ---------------------------------------------------------------------------

/** Legt das Gerät an oder aktualisiert es (ein abgemeldetes Gerät wird wieder aktiv). Liefert die interne Referenz. */
export async function upsertDevice(q: Queryable, userId: string, info: DeviceInfo): Promise<string> {
  const { rows } = await q.query<{ id: string }>(`
    INSERT INTO devices (id, user_id, device_id, name, platform, os_version, app_version)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (user_id, device_id) DO UPDATE SET
      name = EXCLUDED.name, platform = EXCLUDED.platform, os_version = EXCLUDED.os_version,
      app_version = EXCLUDED.app_version, last_seen_at = now(), revoked_at = NULL
    RETURNING id`, [randomUUID(), userId, info.deviceId, info.name, info.platform, info.osVersion, info.appVersion]);
  return rows[0].id;
}

export interface DeviceUpdate {
  name?: string;
  platform?: string;
  osVersion?: string;
  appVersion?: string;
}

/** Ändert Angaben eines eigenen, nicht abgemeldeten Geräts; false = nicht gefunden. */
export async function updateDevice(q: Queryable, userId: string, deviceId: string, u: DeviceUpdate) {
  const res = await q.query(`UPDATE devices SET
      name = COALESCE($1, name), platform = COALESCE($2, platform),
      os_version = COALESCE($3, os_version), app_version = COALESCE($4, app_version)
    WHERE user_id = $5 AND device_id = $6 AND revoked_at IS NULL`,
  [u.name ?? null, u.platform ?? null, u.osVersion ?? null, u.appVersion ?? null, userId, deviceId]);
  return (res.rowCount ?? 0) > 0;
}

export async function revokeDevice(q: Queryable, userId: string, ref: string) {
  await q.query('UPDATE devices SET revoked_at = COALESCE(revoked_at, now()) WHERE user_id = $1 AND id = $2',
    [userId, ref]);
}

const DEVICE_SELECT = `
  SELECT d.id, d.user_id, d.device_id, d.name, d.platform, d.os_version, d.app_version, d.created_at,
         d.last_seen_at, d.revoked_at, d.last_pull_at, d.last_pull_cursor, d.last_push_at,
         d.sync_status, d.last_sync_started_at, d.last_successful_sync_at, d.last_successful_cursor,
         d.last_failed_sync_at, d.last_sync_error_code, d.unresolved_conflicts,
         (SELECT count(*) FROM sessions s
           WHERE s.device_ref = d.id AND s.revoked_at IS NULL AND s.expires_at > now()) AS active_sessions
  FROM devices d`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mapDevice = (r: any): Device => ({
  ref: r.id, userId: r.user_id, deviceId: r.device_id, name: r.name, platform: r.platform, osVersion: r.os_version,
  appVersion: r.app_version, createdAt: r.created_at, lastSeenAt: r.last_seen_at, revokedAt: r.revoked_at,
  lastPullAt: r.last_pull_at, lastPullCursor: r.last_pull_cursor, lastPushAt: r.last_push_at,
  syncStatus: r.sync_status as SyncStatus, lastSyncStartedAt: r.last_sync_started_at,
  lastSuccessfulSyncAt: r.last_successful_sync_at, lastSuccessfulCursor: r.last_successful_cursor,
  lastFailedSyncAt: r.last_failed_sync_at, lastSyncErrorCode: r.last_sync_error_code,
  unresolvedConflicts: r.unresolved_conflicts, activeSessions: r.active_sessions,
});

export async function listDevices(q: Queryable, userId: string, includeRevoked: boolean, limit: number, offset: number) {
  const total = await q.query<{ n: number }>(`SELECT count(*) AS n FROM devices d
    WHERE d.user_id = $1 AND ($2 OR d.revoked_at IS NULL)`, [userId, includeRevoked]);
  const { rows } = await q.query(`${DEVICE_SELECT} WHERE d.user_id = $1 AND ($2 OR d.revoked_at IS NULL)
    ORDER BY d.last_seen_at DESC, d.id LIMIT $3 OFFSET $4`, [userId, includeRevoked, limit, offset]);
  return { items: rows.map(mapDevice), total: total.rows[0].n };
}

export async function findDeviceByRef(q: Queryable, userId: string, ref: string): Promise<Device | null> {
  const { rows } = await q.query(`${DEVICE_SELECT} WHERE d.user_id = $1 AND d.id = $2`, [userId, ref]);
  return rows[0] ? mapDevice(rows[0]) : null;
}

export async function findDeviceByDeviceId(q: Queryable, userId: string, deviceId: string): Promise<Device | null> {
  const { rows } = await q.query(`${DEVICE_SELECT} WHERE d.user_id = $1 AND d.device_id = $2`, [userId, deviceId]);
  return rows[0] ? mapDevice(rows[0]) : null;
}

export async function markDevicePull(q: Queryable, ref: string, cursor: number) {
  await q.query(`UPDATE devices SET last_pull_at = now(), last_pull_cursor = $1, last_seen_at = now()
    WHERE id = $2`, [cursor, ref]);
}

export async function markDevicePush(q: Queryable, ref: string) {
  await q.query('UPDATE devices SET last_push_at = now(), last_seen_at = now() WHERE id = $1', [ref]);
}

export async function markSyncStarted(q: Queryable, ref: string) {
  await q.query('UPDATE devices SET last_sync_started_at = now(), last_seen_at = now() WHERE id = $1', [ref]);
}

/**
 * Speichert das vom Gerät gemeldete Ergebnis eines Synchronisationsvorgangs. Nur SUCCESS/CONFLICT
 * setzen den Zeitpunkt der letzten erfolgreichen Synchronisierung; FAILED wird nie als Erfolg gespeichert.
 */
export async function completeSync(q: Queryable, ref: string, status: SyncStatus, cursor: number | null,
  conflicts: number, errorCode: string | null) {
  if (status === 'FAILED') {
    await q.query(`UPDATE devices SET sync_status = 'FAILED', last_failed_sync_at = now(),
      last_sync_error_code = $1, last_seen_at = now() WHERE id = $2`, [errorCode, ref]);
  } else {
    await q.query(`UPDATE devices SET sync_status = $1, last_successful_sync_at = now(),
      last_successful_cursor = $2, unresolved_conflicts = $3, last_sync_error_code = NULL, last_seen_at = now()
      WHERE id = $4`, [status, cursor, conflicts, ref]);
  }
}

// ---------------------------------------------------------------------------
// Sicherheitsereignisse (technisch, ohne Inhalte)
// ---------------------------------------------------------------------------

export const Events = {
  Registered: 'REGISTERED',
  LoginSucceeded: 'LOGIN_SUCCEEDED',
  LoginFailed: 'LOGIN_FAILED',
  LoginUnknownAccount: 'LOGIN_FAILED_UNKNOWN_ACCOUNT',
  AccountLocked: 'ACCOUNT_LOCKED',
  Logout: 'LOGOUT',
  LogoutAll: 'LOGOUT_ALL',
  RefreshTokenReuse: 'REFRESH_TOKEN_REUSE',
  SessionRevoked: 'SESSION_REVOKED',
  DeviceRevoked: 'DEVICE_REVOKED',
  PasswordChanged: 'PASSWORD_CHANGED',
  PasswordChangeFailed: 'PASSWORD_CHANGE_FAILED',
} as const;

export async function recordSecurityEvent(q: Queryable, userId: string | null, type: string, sessionId: string | null,
  deviceRef: string | null) {
  await q.query(`INSERT INTO security_events (user_id, event_type, session_id, device_ref)
    VALUES ($1, $2, $3, $4)`, [userId, type, sessionId, deviceRef]);
}

export async function listSecurityEvents(q: Queryable, userId: string, limit: number, offset: number) {
  const total = await q.query<{ n: number }>('SELECT count(*) AS n FROM security_events WHERE user_id = $1', [userId]);
  const { rows } = await q.query(`SELECT e.id, e.event_type, e.session_id, d.device_id, e.created_at
    FROM security_events e LEFT JOIN devices d ON d.id = e.device_ref
    WHERE e.user_id = $1 ORDER BY e.created_at DESC, e.id DESC LIMIT $2 OFFSET $3`, [userId, limit, offset]);
  const items: SecurityEvent[] = rows.map((r) => ({
    id: Number(r.id), type: r.event_type, sessionId: r.session_id, deviceId: r.device_id, createdAt: r.created_at,
  }));
  return { items, total: total.rows[0].n };
}
