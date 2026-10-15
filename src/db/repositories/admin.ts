// Datenzugriff für das Admin-Dashboard (seit 2.0). Liefert ausschließlich Metadaten: keine Berichtsinhalte,
// keine Passwort-Hashes, keine Tokens.

import type { Queryable } from '../pool.ts';

export type Role = 'user' | 'admin';

export async function findRole(q: Queryable, userId: string): Promise<Role | null> {
  const { rows } = await q.query<{ role: Role }>('SELECT role FROM users WHERE id = $1', [userId]);
  return rows[0]?.role ?? null;
}

/** Rolle per E-Mail setzen (nur CLI). Rückgabe: ob ein Konto gefunden wurde. */
export async function setRoleByEmail(q: Queryable, email: string, role: Role): Promise<boolean> {
  const r = await q.query('UPDATE users SET role = $1 WHERE email = $2', [role, email.toLowerCase()]);
  return (r.rowCount ?? 0) > 0;
}

export async function listAdmins(q: Queryable): Promise<{ email: string; status: string }[]> {
  const { rows } = await q.query<{ email: string; status: string }>(
    "SELECT email, status FROM users WHERE role = 'admin' ORDER BY email");
  return rows;
}

// ---------------------------------------------------------------------------
// Sitzungen
// ---------------------------------------------------------------------------

export interface AdminSessionRow {
  id: string;
  userId: string;
  csrfToken: string;
  email: string;
}

export async function insertSession(q: Queryable, id: string, userId: string, tokenHash: Buffer, csrf: string, maxSec: number) {
  await q.query(`INSERT INTO admin_sessions (id, user_id, token_hash, csrf_token, expires_at)
    VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5))`, [id, userId, tokenHash, csrf, maxSec]);
}

/**
 * Aktive Sitzung zum Cookie-Hash: nicht widerrufen, nicht abgelaufen, nicht länger als idleSec untätig, Konto
 * aktiv und weiterhin Administrator. Aktualisiert die letzte Aktivität.
 */
export async function touchSession(q: Queryable, tokenHash: Buffer, idleSec: number): Promise<AdminSessionRow | null> {
  const { rows } = await q.query<{ id: string; user_id: string; csrf_token: string; email: string }>(
    `UPDATE admin_sessions s SET last_seen_at = now()
       FROM users u
      WHERE s.token_hash = $1 AND s.user_id = u.id AND s.revoked_at IS NULL AND s.expires_at > now()
        AND s.last_seen_at > now() - make_interval(secs => $2)
        AND u.role = 'admin' AND u.status = 'ACTIVE'
      RETURNING s.id, s.user_id, s.csrf_token, u.email`, [tokenHash, idleSec]);
  const r = rows[0];
  return r ? { id: r.id, userId: r.user_id, csrfToken: r.csrf_token, email: r.email } : null;
}

export async function revokeSession(q: Queryable, id: string) {
  await q.query('UPDATE admin_sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [id]);
}

export async function purgeSessions(q: Queryable): Promise<number> {
  const r = await q.query("DELETE FROM admin_sessions WHERE expires_at < now() - interval '7 days' OR revoked_at < now() - interval '7 days'");
  return r.rowCount ?? 0;
}

// ---------------------------------------------------------------------------
// Audit-Protokoll
// ---------------------------------------------------------------------------

export async function audit(q: Queryable, adminUserId: string | null, action: string, targetUserId: string | null, targetRef: string | null) {
  await q.query('INSERT INTO admin_audit_log (admin_user_id, action, target_user_id, target_ref) VALUES ($1, $2, $3, $4)',
    [adminUserId, action, targetUserId, targetRef]);
}

export interface AuditEntry {
  at: Date;
  admin: string | null;
  action: string;
  target: string | null;
  targetRef: string | null;
}

export async function listAudit(q: Queryable, limit: number): Promise<AuditEntry[]> {
  const { rows } = await q.query<{ created_at: Date; admin: string | null; action: string; target: string | null; target_ref: string | null }>(
    `SELECT a.created_at, au.email AS admin, a.action, tu.email AS target, a.target_ref
       FROM admin_audit_log a
       LEFT JOIN users au ON au.id = a.admin_user_id
       LEFT JOIN users tu ON tu.id = a.target_user_id
      ORDER BY a.created_at DESC LIMIT $1`, [limit]);
  return rows.map((r) => ({ at: r.created_at, admin: r.admin, action: r.action, target: r.target, targetRef: r.target_ref }));
}

// ---------------------------------------------------------------------------
// Benutzer und Geräte
// ---------------------------------------------------------------------------

export interface UserListRow {
  id: string;
  email: string;
  status: string;
  role: Role;
  locked: boolean;
  createdAt: Date;
  lastLoginAt: Date | null;
  devices: number;
  lastSyncAt: Date | null;
}

/** Benutzersuche nach E-Mail (Teilstring, ohne Groß-/Kleinschreibung), seitenweise. */
export async function searchUsers(q: Queryable, search: string, limit: number, offset: number): Promise<{ rows: UserListRow[]; total: number }> {
  const pattern = `%${search.toLowerCase().replace(/[\\%_]/g, (c) => '\\' + c)}%`;
  const { rows } = await q.query<{ id: string; email: string; status: string; role: Role; locked: boolean; created_at: Date; last_login_at: Date | null; devices: string; last_sync: Date | null; total: string }>(
    `SELECT u.id, u.email, u.status, u.role, (u.locked_until IS NOT NULL AND u.locked_until > now()) AS locked,
            u.created_at, u.last_login_at,
            (SELECT count(*) FROM devices d WHERE d.user_id = u.id AND d.revoked_at IS NULL) AS devices,
            (SELECT max(d.last_successful_sync_at) FROM devices d WHERE d.user_id = u.id) AS last_sync,
            count(*) OVER () AS total
       FROM users u
      WHERE u.email LIKE $1 ESCAPE '\\'
      ORDER BY u.created_at DESC
      LIMIT $2 OFFSET $3`, [pattern, limit, offset]);
  return {
    rows: rows.map((r) => ({
      id: r.id, email: r.email, status: r.status, role: r.role, locked: r.locked, createdAt: r.created_at,
      lastLoginAt: r.last_login_at, devices: Number(r.devices), lastSyncAt: r.last_sync,
    })),
    total: rows[0] ? Number(rows[0].total) : 0,
  };
}

export async function findUser(q: Queryable, id: string): Promise<UserListRow | null> {
  const { rows } = await q.query<{ id: string; email: string; status: string; role: Role; locked: boolean; created_at: Date; last_login_at: Date | null; devices: string; last_sync: Date | null }>(
    `SELECT u.id, u.email, u.status, u.role, (u.locked_until IS NOT NULL AND u.locked_until > now()) AS locked,
            u.created_at, u.last_login_at,
            (SELECT count(*) FROM devices d WHERE d.user_id = u.id AND d.revoked_at IS NULL) AS devices,
            (SELECT max(d.last_successful_sync_at) FROM devices d WHERE d.user_id = u.id) AS last_sync
       FROM users u WHERE u.id = $1`, [id]);
  const r = rows[0];
  return r ? {
    id: r.id, email: r.email, status: r.status, role: r.role, locked: r.locked, createdAt: r.created_at,
    lastLoginAt: r.last_login_at, devices: Number(r.devices), lastSyncAt: r.last_sync,
  } : null;
}

export async function setUserStatus(q: Queryable, id: string, status: 'ACTIVE' | 'DISABLED'): Promise<boolean> {
  const r = await q.query('UPDATE users SET status = $1 WHERE id = $2', [status, id]);
  return (r.rowCount ?? 0) > 0;
}

export async function activeSessionCount(q: Queryable, userId: string): Promise<number> {
  const { rows } = await q.query<{ n: string }>(
    'SELECT count(*) AS n FROM sessions WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()', [userId]);
  return Number(rows[0]?.n ?? 0);
}

export interface DeviceRow {
  ref: string;
  userId: string;
  email: string;
  name: string;
  platform: string;
  appVersion: string;
  lastSeenAt: Date;
  syncStatus: string;
  lastSuccessAt: Date | null;
  lastFailedAt: Date | null;
  lastErrorCode: string | null;
  conflicts: number;
  revoked: boolean;
}

const DEVICE_SELECT = `SELECT d.id, d.user_id, u.email, d.name, d.platform, d.app_version, d.last_seen_at, d.sync_status,
    d.last_successful_sync_at, d.last_failed_sync_at, d.last_sync_error_code, d.unresolved_conflicts, (d.revoked_at IS NOT NULL) AS revoked
  FROM devices d JOIN users u ON u.id = d.user_id`;

interface DeviceDbRow {
  id: string; user_id: string; email: string; name: string; platform: string; app_version: string; last_seen_at: Date;
  sync_status: string; last_successful_sync_at: Date | null; last_failed_sync_at: Date | null; last_sync_error_code: string | null;
  unresolved_conflicts: number | null; revoked: boolean;
}

const mapDevice = (r: DeviceDbRow): DeviceRow => ({
  ref: r.id, userId: r.user_id, email: r.email, name: r.name, platform: r.platform, appVersion: r.app_version,
  lastSeenAt: r.last_seen_at, syncStatus: r.sync_status, lastSuccessAt: r.last_successful_sync_at,
  lastFailedAt: r.last_failed_sync_at, lastErrorCode: r.last_sync_error_code, conflicts: r.unresolved_conflicts ?? 0,
  revoked: r.revoked,
});

export async function devicesOf(q: Queryable, userId: string): Promise<DeviceRow[]> {
  const { rows } = await q.query<DeviceDbRow>(`${DEVICE_SELECT} WHERE d.user_id = $1 ORDER BY d.last_seen_at DESC`, [userId]);
  return rows.map(mapDevice);
}

/** Synchronisierungshistorie aus den Gerätezuständen: zuletzt aktive Geräte, Fehler und Konflikte zuerst. */
export async function syncHistory(q: Queryable, onlyProblems: boolean, limit: number): Promise<DeviceRow[]> {
  const { rows } = await q.query<DeviceDbRow>(
    `${DEVICE_SELECT} WHERE d.revoked_at IS NULL ${onlyProblems ? "AND d.sync_status IN ('FAILED', 'CONFLICT')" : ''}
      ORDER BY (d.sync_status IN ('FAILED', 'CONFLICT')) DESC, greatest(d.last_successful_sync_at, d.last_failed_sync_at) DESC NULLS LAST
      LIMIT $1`, [limit]);
  return rows.map(mapDevice);
}

/** Anzahl verarbeiteter Sync-Operationen der letzten 24 Stunden je Ergebnis (Status aus dem gespeicherten Ergebnis). */
export async function recentOperations(q: Queryable): Promise<Record<string, number>> {
  const { rows } = await q.query<{ status: string | null; n: string }>(
    `SELECT result->>'status' AS status, count(*) AS n FROM sync_operations
      WHERE created_at > now() - interval '24 hours' GROUP BY 1`);
  return Object.fromEntries(rows.map((r) => [r.status ?? 'UNBEKANNT', Number(r.n)]));
}

// ---------------------------------------------------------------------------
// System
// ---------------------------------------------------------------------------

export async function migrations(q: Queryable): Promise<{ version: number; name: string; appliedAt: Date }[]> {
  const { rows } = await q.query<{ version: number; name: string; applied_at: Date }>(
    'SELECT version, name, applied_at FROM schema_migrations ORDER BY version');
  return rows.map((r) => ({ version: r.version, name: r.name, appliedAt: r.applied_at }));
}

export async function postgresVersion(q: Queryable): Promise<string> {
  const { rows } = await q.query<{ v: string }>("SELECT current_setting('server_version') AS v");
  return rows[0]?.v ?? '';
}

export interface BackupRun {
  startedAt: Date;
  finishedAt: Date;
  fileName: string;
  sizeBytes: number | null;
  sha256: string | null;
  verified: boolean;
  verification: string | null;
  result: 'SUCCESS' | 'FAILED';
  error: string | null;
}

export async function insertBackupRun(q: Queryable, b: Omit<BackupRun, 'finishedAt'>) {
  await q.query(`INSERT INTO backup_runs (started_at, file_name, size_bytes, sha256, verified, verification, result, error)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
  [b.startedAt, b.fileName, b.sizeBytes, b.sha256, b.verified, b.verification, b.result, b.error]);
}

export async function listBackups(q: Queryable, limit: number): Promise<BackupRun[]> {
  const { rows } = await q.query<{ started_at: Date; finished_at: Date; file_name: string; size_bytes: string | null; sha256: string | null; verified: boolean; verification: string | null; result: 'SUCCESS' | 'FAILED'; error: string | null }>(
    'SELECT * FROM backup_runs ORDER BY finished_at DESC LIMIT $1', [limit]);
  return rows.map((r) => ({
    startedAt: r.started_at, finishedAt: r.finished_at, fileName: r.file_name, sizeBytes: r.size_bytes === null ? null : Number(r.size_bytes),
    sha256: r.sha256, verified: r.verified, verification: r.verification, result: r.result, error: r.error,
  }));
}
