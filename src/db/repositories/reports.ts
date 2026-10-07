import type {
  DailyReport, DailyValues, Origin, Profile, ProfileValues, ReportStatus, WeeklyReport, WeeklyValues, WriteMeta,
  WritingStyle,
} from '../../domain/models.ts';
import { dailyValuesEqual, weeklyValuesEqual, weekOf } from '../../domain/models.ts';
import type { Queryable } from '../pool.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// Profil
// ---------------------------------------------------------------------------

const PROFILE_COLUMNS = `user_id, name, profession, company, department, trainer_name, training_start,
  training_end, writing_style, version, created_at, updated_at, change_seq`;

const mapProfile = (r: any): Profile => ({
  userId: r.user_id,
  values: {
    name: r.name, profession: r.profession, company: r.company, department: r.department, trainerName: r.trainer_name,
    trainingStart: r.training_start, trainingEnd: r.training_end, writingStyle: r.writing_style as WritingStyle,
  },
  version: r.version, createdAt: r.created_at, updatedAt: r.updated_at, changeSeq: r.change_seq,
});

export async function insertEmptyProfile(q: Queryable, userId: string) {
  await q.query('INSERT INTO user_profiles (user_id) VALUES ($1)', [userId]);
}

export async function findProfile(q: Queryable, userId: string, forUpdate = false): Promise<Profile | null> {
  const { rows } = await q.query(`SELECT ${PROFILE_COLUMNS} FROM user_profiles WHERE user_id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
    [userId]);
  return rows[0] ? mapProfile(rows[0]) : null;
}

/** Ändert nur, wenn die gespeicherte Version expected entspricht (null = Versionskonflikt). */
export async function updateProfile(q: Queryable, userId: string, expected: number, v: ProfileValues): Promise<Profile | null> {
  const { rows } = await q.query(`
    UPDATE user_profiles SET name = $1, profession = $2, company = $3, department = $4, trainer_name = $5,
      training_start = $6, training_end = $7, writing_style = $8, version = version + 1
    WHERE user_id = $9 AND version = $10
    RETURNING ${PROFILE_COLUMNS}`,
  [v.name, v.profession, v.company, v.department, v.trainerName, v.trainingStart, v.trainingEnd, v.writingStyle,
    userId, expected]);
  return rows[0] ? mapProfile(rows[0]) : null;
}

export async function profilesChangedSince(q: Queryable, userId: string, cursor: number, limit: number) {
  const { rows } = await q.query(`SELECT ${PROFILE_COLUMNS} FROM user_profiles
    WHERE user_id = $1 AND change_seq > $2 ORDER BY change_seq LIMIT $3`, [userId, cursor, limit]);
  return rows.map(mapProfile);
}

// ---------------------------------------------------------------------------
// Gemeinsame Herkunftsspalten
// ---------------------------------------------------------------------------

// Liefert die stabilen Geräte-IDs (nicht die internen Referenzen) per Unterabfrage.
const ORIGIN_COLUMNS = `client_updated_at, client_local_id,
  (SELECT d.device_id FROM devices d WHERE d.id = created_by_device_ref) AS created_by_device_id,
  (SELECT d.device_id FROM devices d WHERE d.id = last_device_ref) AS last_device_id,
  last_operation_id`;

const mapOrigin = (r: any): Origin => ({
  clientUpdatedAt: r.client_updated_at, clientLocalId: r.client_local_id, createdByDeviceId: r.created_by_device_id,
  lastDeviceId: r.last_device_id, lastOperationId: r.last_operation_id,
});

/** Datenbankzugriff, den der versionierte Schreibmechanismus (services/versioned.ts) benötigt. */
export interface VersionedStore<V, R> {
  findById(q: Queryable, id: string, forUpdate: boolean): Promise<R | null>;
  insert(q: Queryable, userId: string, id: string, v: V, m: WriteMeta): Promise<R>;
  update(q: Queryable, id: string, expected: number, v: V, m: WriteMeta): Promise<R | null>;
  softDelete(q: Queryable, id: string, expected: number, m: WriteMeta): Promise<R | null>;
  findCollision(q: Queryable, userId: string, excludeId: string, v: V): Promise<R | null>;
  owner(r: R): string;
  version(r: R): number;
  deleted(r: R): boolean;
  same(r: R, v: V): boolean;
}

// ---------------------------------------------------------------------------
// Tagesberichte
// ---------------------------------------------------------------------------

const DAILY_COLUMNS = `id, user_id, report_date, text, note, order_index, status, version,
  created_at, updated_at, deleted_at, change_seq, ${ORIGIN_COLUMNS}`;

const mapDaily = (r: any): DailyReport => ({
  id: r.id,
  userId: r.user_id,
  values: { date: r.report_date, text: r.text, note: r.note, orderIndex: r.order_index, status: r.status as ReportStatus },
  version: r.version, createdAt: r.created_at, updatedAt: r.updated_at, deletedAt: r.deleted_at, changeSeq: r.change_seq,
  origin: mapOrigin(r),
});

const one = <T>(rows: any[], map: (r: any) => T): T | null => (rows[0] ? map(rows[0]) : null);

export const dailyStore: VersionedStore<DailyValues, DailyReport> = {
  async findById(q, id, forUpdate) {
    const { rows } = await q.query(`SELECT ${DAILY_COLUMNS} FROM daily_reports WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`, [id]);
    return one(rows, mapDaily);
  },
  async insert(q, userId, id, v, m) {
    const { rows } = await q.query(`
      INSERT INTO daily_reports (id, user_id, report_date, text, note, order_index, status,
        created_by_device_ref, last_device_ref, last_operation_id, client_updated_at, client_local_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $9, $10, $11)
      RETURNING ${DAILY_COLUMNS}`,
    [id, userId, v.date, v.text, v.note, v.orderIndex, v.status, m.deviceRef, m.operationId, m.clientUpdatedAt,
      m.clientLocalId]);
    return mapDaily(rows[0]);
  },
  async update(q, id, expected, v, m) {
    const { rows } = await q.query(`
      UPDATE daily_reports SET report_date = $1, text = $2, note = $3, order_index = $4, status = $5,
        version = version + 1, last_device_ref = $6, last_operation_id = $7, client_updated_at = $8,
        client_local_id = COALESCE($9, client_local_id)
      WHERE id = $10 AND version = $11 AND deleted_at IS NULL
      RETURNING ${DAILY_COLUMNS}`,
    [v.date, v.text, v.note, v.orderIndex, v.status, m.deviceRef, m.operationId, m.clientUpdatedAt, m.clientLocalId,
      id, expected]);
    return one(rows, mapDaily);
  },
  // Tombstone: Inhalt wird entfernt (Datenminimierung), ID, Datum und Version bleiben erhalten.
  async softDelete(q, id, expected, m) {
    const { rows } = await q.query(`
      UPDATE daily_reports SET deleted_at = now(), text = '', note = '', version = version + 1,
        last_device_ref = $1, last_operation_id = $2, client_updated_at = $3
      WHERE id = $4 AND version = $5 AND deleted_at IS NULL
      RETURNING ${DAILY_COLUMNS}`, [m.deviceRef, m.operationId, m.clientUpdatedAt, id, expected]);
    return one(rows, mapDaily);
  },
  async findCollision() {
    return null; // mehrere Tätigkeiten pro Tag sind erlaubt (wie in der App)
  },
  owner: (r) => r.userId,
  version: (r) => r.version,
  deleted: (r) => r.deletedAt !== null,
  same: (r, v) => dailyValuesEqual(r.values, v),
};

export async function findActiveDaily(q: Queryable, userId: string, id: string) {
  const { rows } = await q.query(`SELECT ${DAILY_COLUMNS} FROM daily_reports
    WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`, [id, userId]);
  return one(rows, mapDaily);
}

/** Listenfilter; alle Werte werden als Parameter gebunden. */
export interface ReportFilter {
  date?: string;
  from?: string;
  to?: string;
  statuses: string[];
  ascending: boolean;
  limit: number;
  offset: number;
}

/** Baut WHERE-Klauseln ausschließlich aus festen Fragmenten und Platzhaltern. */
class Where {
  readonly parts: string[];
  readonly args: unknown[];

  constructor(first: string, ...args: unknown[]) {
    this.parts = [first];
    this.args = args;
  }

  add(fragment: string, arg: unknown) {
    this.args.push(arg);
    this.parts.push(fragment.replace('$?', `$${this.args.length}`));
  }

  get sql() {
    return this.parts.join(' AND ');
  }
}

export async function listDaily(q: Queryable, userId: string, f: ReportFilter) {
  const w = new Where('user_id = $1 AND deleted_at IS NULL', userId);
  if (f.date) w.add('report_date = $?', f.date);
  if (f.from) w.add('report_date >= $?', f.from);
  if (f.to) w.add('report_date <= $?', f.to);
  if (f.statuses.length) w.add('status = ANY($?)', f.statuses);
  const total = await q.query<{ n: number }>(`SELECT count(*) AS n FROM daily_reports WHERE ${w.sql}`, w.args);
  const order = f.ascending ? 'ASC' : 'DESC'; // aus fester Auswahl, nie aus Benutzereingaben
  const n = w.args.length;
  const { rows } = await q.query(`SELECT ${DAILY_COLUMNS} FROM daily_reports WHERE ${w.sql}
    ORDER BY report_date ${order}, order_index ASC, created_at ASC, id ASC LIMIT $${n + 1} OFFSET $${n + 2}`,
  [...w.args, f.limit, f.offset]);
  return { items: rows.map(mapDaily), total: total.rows[0].n };
}

export async function listDailyInRange(q: Queryable, userId: string, from: string, to: string) {
  const { rows } = await q.query(`SELECT ${DAILY_COLUMNS} FROM daily_reports
    WHERE user_id = $1 AND deleted_at IS NULL AND report_date BETWEEN $2 AND $3
    ORDER BY report_date ASC, order_index ASC, created_at ASC, id ASC`, [userId, from, to]);
  return rows.map(mapDaily);
}

/** Alle Änderungen inklusive Tombstones nach dem Cursor (Index user_id, change_seq). */
export async function dailyChangedSince(q: Queryable, userId: string, cursor: number, limit: number) {
  const { rows } = await q.query(`SELECT ${DAILY_COLUMNS} FROM daily_reports
    WHERE user_id = $1 AND change_seq > $2 ORDER BY change_seq LIMIT $3`, [userId, cursor, limit]);
  return rows.map(mapDaily);
}

// ---------------------------------------------------------------------------
// Wochenberichte
// ---------------------------------------------------------------------------

const WEEKLY_COLUMNS = `id, user_id, week_start, content, status, generated_at, version,
  created_at, updated_at, deleted_at, change_seq, ${ORIGIN_COLUMNS}`;

const mapWeekly = (r: any): WeeklyReport => ({
  id: r.id,
  userId: r.user_id,
  values: { week: weekOf(r.week_start), content: r.content, status: r.status as ReportStatus, generatedAt: r.generated_at },
  version: r.version, createdAt: r.created_at, updatedAt: r.updated_at, deletedAt: r.deleted_at, changeSeq: r.change_seq,
  origin: mapOrigin(r),
});

export const weeklyStore: VersionedStore<WeeklyValues, WeeklyReport> = {
  async findById(q, id, forUpdate) {
    const { rows } = await q.query(`SELECT ${WEEKLY_COLUMNS} FROM weekly_reports WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`, [id]);
    return one(rows, mapWeekly);
  },
  async insert(q, userId, id, v, m) {
    const { rows } = await q.query(`
      INSERT INTO weekly_reports (id, user_id, week_start, week_end, iso_year, iso_week, content, status,
        generated_at, created_by_device_ref, last_device_ref, last_operation_id, client_updated_at, client_local_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10, $11, $12, $13)
      RETURNING ${WEEKLY_COLUMNS}`,
    [id, userId, v.week.start, v.week.end, v.week.year, v.week.week, v.content, v.status, v.generatedAt,
      m.deviceRef, m.operationId, m.clientUpdatedAt, m.clientLocalId]);
    return mapWeekly(rows[0]);
  },
  async update(q, id, expected, v, m) {
    const { rows } = await q.query(`
      UPDATE weekly_reports SET week_start = $1, week_end = $2, iso_year = $3, iso_week = $4, content = $5,
        status = $6, generated_at = $7, version = version + 1, last_device_ref = $8, last_operation_id = $9,
        client_updated_at = $10, client_local_id = COALESCE($11, client_local_id)
      WHERE id = $12 AND version = $13 AND deleted_at IS NULL
      RETURNING ${WEEKLY_COLUMNS}`,
    [v.week.start, v.week.end, v.week.year, v.week.week, v.content, v.status, v.generatedAt, m.deviceRef,
      m.operationId, m.clientUpdatedAt, m.clientLocalId, id, expected]);
    return one(rows, mapWeekly);
  },
  async softDelete(q, id, expected, m) {
    const { rows } = await q.query(`
      UPDATE weekly_reports SET deleted_at = now(), content = '', version = version + 1,
        last_device_ref = $1, last_operation_id = $2, client_updated_at = $3
      WHERE id = $4 AND version = $5 AND deleted_at IS NULL
      RETURNING ${WEEKLY_COLUMNS}`, [m.deviceRef, m.operationId, m.clientUpdatedAt, id, expected]);
    return one(rows, mapWeekly);
  },
  // Ein anderer aktiver Wochenbericht derselben Woche.
  async findCollision(q, userId, excludeId, v) {
    const { rows } = await q.query(`SELECT ${WEEKLY_COLUMNS} FROM weekly_reports
      WHERE user_id = $1 AND week_start = $2 AND deleted_at IS NULL AND id <> $3`, [userId, v.week.start, excludeId]);
    return one(rows, mapWeekly);
  },
  owner: (r) => r.userId,
  version: (r) => r.version,
  deleted: (r) => r.deletedAt !== null,
  same: (r, v) => weeklyValuesEqual(r.values, v),
};

export async function findActiveWeekly(q: Queryable, userId: string, id: string) {
  const { rows } = await q.query(`SELECT ${WEEKLY_COLUMNS} FROM weekly_reports
    WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`, [id, userId]);
  return one(rows, mapWeekly);
}

export async function findActiveWeeklyForWeek(q: Queryable, userId: string, weekStart: string) {
  const { rows } = await q.query(`SELECT ${WEEKLY_COLUMNS} FROM weekly_reports
    WHERE user_id = $1 AND week_start = $2 AND deleted_at IS NULL`, [userId, weekStart]);
  return one(rows, mapWeekly);
}

/** Wochen, die den Zeitraum [from, to] überschneiden. */
export async function listWeekly(q: Queryable, userId: string, f: ReportFilter) {
  const w = new Where('user_id = $1 AND deleted_at IS NULL', userId);
  if (f.from) w.add('week_end >= $?', f.from);
  if (f.to) w.add('week_start <= $?', f.to);
  if (f.statuses.length) w.add('status = ANY($?)', f.statuses);
  const total = await q.query<{ n: number }>(`SELECT count(*) AS n FROM weekly_reports WHERE ${w.sql}`, w.args);
  const order = f.ascending ? 'ASC' : 'DESC';
  const n = w.args.length;
  const { rows } = await q.query(`SELECT ${WEEKLY_COLUMNS} FROM weekly_reports WHERE ${w.sql}
    ORDER BY week_start ${order}, id ASC LIMIT $${n + 1} OFFSET $${n + 2}`, [...w.args, f.limit, f.offset]);
  return { items: rows.map(mapWeekly), total: total.rows[0].n };
}

export async function weeklyChangedSince(q: Queryable, userId: string, cursor: number, limit: number) {
  const { rows } = await q.query(`SELECT ${WEEKLY_COLUMNS} FROM weekly_reports
    WHERE user_id = $1 AND change_seq > $2 ORDER BY change_seq LIMIT $3`, [userId, cursor, limit]);
  return rows.map(mapWeekly);
}

/** Höchste Änderungsnummer aller Daten eines Kontos. */
export async function serverCursor(q: Queryable, userId: string): Promise<number> {
  const { rows } = await q.query<{ c: number }>(`SELECT GREATEST(
    (SELECT COALESCE(MAX(change_seq), 0) FROM daily_reports WHERE user_id = $1),
    (SELECT COALESCE(MAX(change_seq), 0) FROM weekly_reports WHERE user_id = $1),
    (SELECT COALESCE(MAX(change_seq), 0) FROM user_profiles WHERE user_id = $1)) AS c`, [userId]);
  return rows[0].c;
}
