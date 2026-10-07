import type { Database, Queryable } from '../pool.ts';

// ---------------------------------------------------------------------------
// Idempotenz von Synchronisationsoperationen
// ---------------------------------------------------------------------------

export interface StoredOperation {
  entityType: string;
  entityId: string;
  requestHash: Buffer;
  hashFormat: number; // 1 = Server 1.1, 2 = Server 1.2
  result: Record<string, unknown>;
}

export async function findOperation(q: Queryable, userId: string, operationId: string): Promise<StoredOperation | null> {
  const { rows } = await q.query(`SELECT entity_type, entity_id, request_hash, hash_format, result FROM sync_operations
    WHERE user_id = $1 AND operation_id = $2`, [userId, operationId]);
  const r = rows[0];
  return r ? { entityType: r.entity_type, entityId: r.entity_id, requestHash: r.request_hash, hashFormat: r.hash_format, result: r.result } : null;
}

export async function insertOperation(q: Queryable, userId: string, operationId: string, deviceRef: string | null,
  entityType: string, entityId: string, requestHash: Buffer, result: unknown) {
  await q.query(`INSERT INTO sync_operations (user_id, operation_id, device_ref, entity_type, entity_id, request_hash, result, hash_format)
    VALUES ($1, $2, $3, $4, $5, $6, $7, 2)`, [userId, operationId, deviceRef, entityType, entityId, requestHash,
    JSON.stringify(result)]);
}

// ---------------------------------------------------------------------------
// Cursor-Zustand (Epoche und Untergrenze gültiger Sync-Cursor)
// ---------------------------------------------------------------------------

const KEY_MIN_VALID = 'sync_min_valid_cursor';
const KEY_EPOCH = 'sync_cursor_epoch';
const MAINTENANCE_LOCK_ID = 726_174_520_032; // gleiche Sperre wie in 1.1

/**
 * Epoch steigt bei jeder Tombstone-Bereinigung und beim Zurücksetzen nach einer Wiederherstellung.
 * Ein Cursor der aktuellen Epoche ist immer gültig; ein Cursor einer älteren Epoche nur, wenn er
 * mindestens minValid ist (das Gerät kannte dann alle bereinigten Löschungen bereits).
 */
export interface CursorState {
  minValid: number;
  epoch: number;
}

export async function loadCursorState(q: Queryable): Promise<CursorState> {
  const { rows } = await q.query<{ key: string; value: string }>('SELECT key, value FROM server_state WHERE key IN ($1, $2)',
    [KEY_MIN_VALID, KEY_EPOCH]);
  const s: CursorState = { minValid: 0, epoch: 0 };
  for (const r of rows) {
    if (!/^\d+$/.test(r.value)) throw new Error(`ungültiger Serverzustand ${r.key}`);
    if (r.key === KEY_MIN_VALID) s.minValid = Number(r.value);
    else s.epoch = Number(r.value);
  }
  return s;
}

async function saveCursorState(q: Queryable, s: CursorState) {
  await q.query(`INSERT INTO server_state (key, value) VALUES ($1, $2), ($3, $4)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
  [KEY_MIN_VALID, String(s.minValid), KEY_EPOCH, String(s.epoch)]);
}

/**
 * Erklärt alle bisher ausgestellten Sync-Cursor für ungültig (nach dem Einspielen eines Backups springen
 * die Änderungsnummern zurück). Die Sequenz wird weit nach vorne gesetzt, damit alle neuen Änderungen
 * über jedem jemals ausgestellten Cursor liegen.
 */
export async function invalidateSyncCursors(db: Database) {
  await db.tx(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock($1)', [MAINTENANCE_LOCK_ID]);
    const state = await loadCursorState(c);
    const { rows } = await c.query<{ v: number }>(`SELECT setval('sync_change_seq',
      (SELECT last_value FROM sync_change_seq) + 1000000000000) AS v`);
    await saveCursorState(c, { minValid: rows[0].v, epoch: state.epoch + 1 });
  });
}

// ---------------------------------------------------------------------------
// Wartung
// ---------------------------------------------------------------------------

export interface Retention {
  tombstonesSec: number;
  operationsSec: number;
  securityEventsSec: number;
  sessionsSec: number;
}

export interface MaintenanceResult {
  skipped: boolean;
  tombstonesPurged: number;
  minValidCursor: number;
  operationsPurged: number;
  securityEventsPurged: number;
  sessionsPurged: number;
  refreshTokensPurged: number;
}

/**
 * Entfernt Daten mit abgelaufener Aufbewahrungsfrist – alles in einer Transaktion. Tombstones werden
 * nur zusammen mit der Anhebung der Cursor-Untergrenze gelöscht, damit kein Gerät eine Löschung verpasst.
 */
export async function runMaintenance(db: Database, r: Retention): Promise<MaintenanceResult> {
  return db.tx(async (c) => {
    const res: MaintenanceResult = {
      skipped: false, tombstonesPurged: 0, minValidCursor: 0, operationsPurged: 0, securityEventsPurged: 0,
      sessionsPurged: 0, refreshTokensPurged: 0,
    };
    const lock = await c.query<{ ok: boolean }>('SELECT pg_try_advisory_xact_lock($1) AS ok', [MAINTENANCE_LOCK_ID]);
    if (!lock.rows[0].ok) return { ...res, skipped: true };

    let maxPurged = 0;
    for (const table of ['daily_reports', 'weekly_reports']) { // feste Tabellennamen, keine Eingaben
      const { rows } = await c.query<{ n: number; m: number }>(`WITH d AS (DELETE FROM ${table}
          WHERE deleted_at IS NOT NULL AND deleted_at < now() - make_interval(secs => $1) RETURNING change_seq)
        SELECT count(*) AS n, COALESCE(MAX(change_seq), 0) AS m FROM d`, [r.tombstonesSec]);
      res.tombstonesPurged += rows[0].n;
      maxPurged = Math.max(maxPurged, rows[0].m);
    }
    const state = await loadCursorState(c);
    res.minValidCursor = Math.max(state.minValid, maxPurged);
    if (res.minValidCursor > state.minValid) {
      // Neue Epoche: ältere Cursor unterhalb der neuen Untergrenze könnten Löschungen verpasst haben.
      await saveCursorState(c, { minValid: res.minValidCursor, epoch: state.epoch + 1 });
    }

    const count = async (sql: string, secs: number) => (await c.query(sql, [secs])).rowCount ?? 0;
    res.operationsPurged = await count('DELETE FROM sync_operations WHERE created_at < now() - make_interval(secs => $1)',
      r.operationsSec);
    res.securityEventsPurged = await count('DELETE FROM security_events WHERE created_at < now() - make_interval(secs => $1)',
      r.securityEventsSec);
    res.refreshTokensPurged = await count(`DELETE FROM refresh_tokens t USING sessions s
      WHERE s.id = t.session_id AND s.revoked_at IS NULL AND s.expires_at > now()
        AND COALESCE(t.used_at, t.expires_at) < now() - make_interval(secs => $1)`, r.sessionsSec);
    res.sessionsPurged = await count(`DELETE FROM sessions
      WHERE COALESCE(revoked_at, expires_at) < now() - make_interval(secs => $1)`, r.sessionsSec);
    return res;
  });
}
