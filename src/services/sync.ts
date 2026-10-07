// Synchronisierung zwischen Android-Geräten und Server (Protokoll: docs/SYNC.md).
//  - Pull: alle Änderungen eines Kontos nach einem Cursor (inkl. Tombstones), aus EINEM konsistenten Snapshot.
//  - Push: lokale Änderungen mit Basisversion; jede einzeln und atomar, idempotent über operationId.
//  - Konflikte werden gemeldet, nie stillschweigend überschrieben.

import { createHash } from 'node:crypto';
import {
  ApiError, badParameter, Codes, type ConflictInfo, type ConflictReason, type FieldError, validationError,
} from '../domain/errors.ts';
import { formatTime, formatTimeOrNull } from '../domain/date.ts';
import { dailyDto, profileDto, weeklyDto, type WriteMeta } from '../domain/models.ts';
import { type Database, lockUser, type Queryable } from '../db/pool.ts';
import * as repo from '../db/repositories/reports.ts';
import * as ops from '../db/repositories/maintenance.ts';
import * as devices from '../db/repositories/sessions.ts';
import type { Logger } from '../util/logger.ts';
import { asObject, type Json, optArray, optInt, optString, Validator } from '../validation/validator.ts';
import type { ProfileService } from './account.ts';
import type { Principal } from './auth.ts';
import type { ReportService } from './reports.ts';
import { readDailyValues, readMeta, readProfileValues, readWeeklyValues } from './requests.ts';
import type { Outcome, VersionedWriter } from './versioned.ts';

export const MAX_PUSH_ITEMS = 100;
export const DEFAULT_PULL_LIMIT = 200;
export const MAX_PULL_LIMIT = 500;

const SYNC_TYPES = ['DAILY_REPORT', 'WEEKLY_REPORT', 'PROFILE'] as const;
const SYNC_OPERATIONS = ['UPSERT', 'DELETE'] as const;

/** Synchronisationsstand: Änderungsnummer und Epoche. Für Clients ein undurchsichtiger String. */
export interface Cursor {
  seq: number;
  epoch: number;
}

export const formatCursor = (c: Cursor) => (c.epoch === 0 ? String(c.seq) : `${c.seq}.${c.epoch}`);

/** "<Nummer>" (Epoche 0, wie in 1.0) oder "<Nummer>.<Epoche>"; leer = alles. */
export function parseCursor(raw: string | undefined): Cursor {
  if (raw === undefined || raw === '') return { seq: 0, epoch: 0 };
  const m = /^(\d{1,18})(?:\.(\d{1,18}))?$/.exec(raw);
  if (!m || (m[2] !== undefined && Number(m[2]) < 1)) throw badParameter('cursor', 'invalid_cursor');
  return { seq: Number(m[1]), epoch: m[2] === undefined ? 0 : Number(m[2]) };
}

export interface SyncChange {
  type: string;
  id: string;
  version: number;
  changeSeq: number;
  deleted: boolean;
  updatedAt: string;
  echo?: boolean;
  data: unknown;
}

interface PushResult {
  index: number;
  operationId: string | null;
  type: string | null;
  id: string | null;
  status: 'APPLIED' | 'CONFLICT' | 'REJECTED';
  version: number | null;
  changeSeq: number | null;
  record: unknown;
  conflict: ConflictInfo | null;
  error: { code: string; message: string; details?: FieldError[] } | null;
  replayed: boolean;
}

interface Described {
  version: number;
  changeSeq: number;
  deleted: boolean;
  dto: unknown;
}

type Runner = (c: Queryable, base: PushResult) => Promise<PushResult>;

export class SyncService {
  private readonly db: Database;
  private readonly reports: ReportService;
  private readonly profiles: ProfileService;
  private readonly log: Logger;
  now: () => Date;

  constructor(db: Database, reports: ReportService, profiles: ProfileService, now: () => Date, log: Logger) {
    this.db = db;
    this.reports = reports;
    this.profiles = profiles;
    this.now = now;
    this.log = log;
  }

  /**
   * Erkennt Cursor, die Löschungen verpasst haben könnten (Tombstones bereinigt oder Backup eingespielt).
   * Cursor der aktuellen Epoche sind immer gültig, auch numerisch kleine Zwischen-Cursor einer Neusynchronisierung.
   */
  private async checkCursor(c: Cursor): Promise<ops.CursorState> {
    const state = await ops.loadCursorState(this.db.pool);
    if (c.seq === 0 || c.epoch === state.epoch || (c.epoch < state.epoch && c.seq >= state.minValid)) return state;
    throw new ApiError(410, Codes.SyncCursorExpired,
      'Der Synchronisationsstand ist zu alt. Bitte vollständig neu synchronisieren (cursor=0).');
  }

  async pull(p: Principal, cursor: Cursor, limit: number) {
    const state = await this.checkCursor(cursor);
    return this.pullFrom(p, cursor.seq, state.epoch, limit, new Map());
  }

  private async pullFrom(p: Principal, cursor: number, epoch: number, limit: number, echo: Map<string, number>) {
    // Ein einziger Snapshot über alle Tabellen: Sonst könnte eine zwischen zwei Abfragen committete
    // Änderung mit niedrigerer Nummer übersprungen werden.
    const { changes, hasMore } = await this.db.snapshot(async (c) => {
      const fetch = limit + 1;
      const [daily, weekly, profiles] = [
        await repo.dailyChangedSince(c, p.userId, cursor, fetch),
        await repo.weeklyChangedSince(c, p.userId, cursor, fetch),
        await repo.profilesChangedSince(c, p.userId, cursor, fetch),
      ];
      const all: SyncChange[] = [
        ...daily.map((r) => change('DAILY_REPORT', r.id, r.version, r.changeSeq, r.deletedAt !== null, r.updatedAt, dailyDto(r))),
        ...weekly.map((r) => change('WEEKLY_REPORT', r.id, r.version, r.changeSeq, r.deletedAt !== null, r.updatedAt, weeklyDto(r))),
        ...profiles.map((r) => change('PROFILE', r.userId, r.version, r.changeSeq, false, r.updatedAt, profileDto(r))),
      ].sort((a, b) => a.changeSeq - b.changeSeq);
      return { changes: all.slice(0, limit), hasMore: all.length > limit };
    });
    for (const ch of changes) if (echo.get(ch.id) === ch.version) ch.echo = true;
    const next = changes.length ? changes[changes.length - 1].changeSeq : cursor;
    if (p.deviceRef) await devices.markDevicePull(this.db.pool, p.deviceRef, next);
    return { changes, nextCursor: formatCursor({ seq: next, epoch }), hasMore, serverTime: formatTime(this.now()) };
  }

  async push(p: Principal, body: Json) {
    const items = optArray(body, 'changes');
    if (!items) throw validationError([{ field: 'changes', issue: 'required' }]);
    return this.pushItems(p, items);
  }

  private async pushItems(p: Principal, items: unknown[]) {
    if (items.length > MAX_PUSH_ITEMS) throw validationError([{ field: 'changes', issue: `too_many:max=${MAX_PUSH_ITEMS}` }]);
    const results: PushResult[] = [];
    let conflicts = 0;
    for (const [i, item] of items.entries()) {
      const r = await this.applyItem(p, i, asObject(item));
      if (r.status === 'CONFLICT') conflicts++;
      results.push(r);
    }
    if (p.deviceRef && items.length > 0) await devices.markDevicePush(this.db.pool, p.deviceRef);
    if (conflicts > 0) this.log.info('Sync-Push mit Konflikten', { user_id: p.userId, conflicts });
    return { results, serverTime: formatTime(this.now()) };
  }

  /** Lokale Änderungen anwenden, danach Serveränderungen ab dem Cursor liefern (eigene als echo markiert). */
  async sync(p: Principal, body: Json) {
    const cursor = parseCursor(optString(body, 'cursor'));
    const limitRaw = optInt(body, 'limit');
    if (limitRaw !== undefined && (limitRaw < 1 || limitRaw > MAX_PULL_LIMIT)) {
      throw validationError([{ field: 'limit', issue: `out_of_range:1..${MAX_PULL_LIMIT}` }]);
    }
    const state = await this.checkCursor(cursor);
    if (p.deviceRef) await devices.markSyncStarted(this.db.pool, p.deviceRef);
    const pushed = await this.pushItems(p, optArray(body, 'changes') ?? []);
    const echo = new Map<string, number>();
    for (const r of pushed.results) {
      if (r.status === 'APPLIED' && r.id && r.version !== null) echo.set(r.id.toLowerCase(), r.version);
    }
    const pulled = await this.pullFrom(p, cursor.seq, state.epoch, limitRaw ?? DEFAULT_PULL_LIMIT, echo);
    return {
      push: pushed,
      pull: pulled,
      device: p.deviceRef ? await this.deviceStatus(p) : null,
      serverTime: formatTime(this.now()),
    };
  }

  /**
   * Ergebnis eines Synchronisationsvorgangs für das aktuelle Gerät. Nur das Gerät weiß, ob es alles
   * übernommen hat; ein fehlgeschlagener Vorgang wird nie als Erfolg gespeichert.
   */
  async complete(p: Principal, body: Json) {
    if (!p.deviceRef) {
      throw new ApiError(409, Codes.DeviceRequired,
        'Diese Sitzung ist keinem Gerät zugeordnet. Bitte zuerst POST /api/v1/devices aufrufen.');
    }
    const v = new Validator();
    const resultRaw = optString(body, 'result');
    const result = v.enumValue('result', resultRaw, ['SUCCESS', 'FAILED'], '');
    v.check(resultRaw !== undefined, 'result', 'required');
    const conflicts = v.int('unresolvedConflicts', optInt(body, 'unresolvedConflicts'), 0, 100000, 0, false) ?? 0;
    let cursor: number | null = null;
    if (result === 'SUCCESS') {
      const raw = optString(body, 'cursor');
      if (raw === undefined) v.add('cursor', 'required');
      else {
        try {
          cursor = parseCursor(raw).seq;
        } catch {
          v.add('cursor', 'invalid_cursor');
        }
      }
    }
    const errorCode = optString(body, 'errorCode');
    if (errorCode !== undefined && !/^[A-Z0-9_]{1,64}$/.test(errorCode)) v.add('errorCode', 'invalid_value:[A-Z0-9_]{1,64}');
    v.throwIfInvalid();
    if (cursor !== null && cursor > (await repo.serverCursor(this.db.pool, p.userId))) {
      throw validationError([{ field: 'cursor', issue: 'beyond_server_cursor' }]);
    }
    const status = result === 'SUCCESS' ? (conflicts > 0 ? 'CONFLICT' : 'SUCCESS') : 'FAILED';
    await devices.completeSync(this.db.pool, p.deviceRef, status, cursor, conflicts, errorCode ?? null);
    return this.deviceStatus(p);
  }

  async status(p: Principal) {
    const cursor = await repo.serverCursor(this.db.pool, p.userId);
    const state = await ops.loadCursorState(this.db.pool);
    return {
      serverCursor: String(cursor),
      minValidCursor: String(state.minValid),
      cursorEpoch: state.epoch,
      serverTime: formatTime(this.now()),
      device: p.deviceRef ? await this.deviceStatus(p) : null,
    };
  }

  private async deviceStatus(p: Principal) {
    const d = await devices.findDeviceByRef(this.db.pool, p.userId, p.deviceRef!);
    if (!d) return null;
    const opt = (n: number | null) => (n === null ? null : String(n));
    return {
      deviceId: d.deviceId,
      syncStatus: d.syncStatus,
      lastSyncAt: formatTimeOrNull(d.lastSuccessfulSyncAt),
      lastSuccessfulCursor: opt(d.lastSuccessfulCursor),
      lastSyncStartedAt: formatTimeOrNull(d.lastSyncStartedAt),
      lastFailedSyncAt: formatTimeOrNull(d.lastFailedSyncAt),
      lastSyncErrorCode: d.lastSyncErrorCode,
      unresolvedConflicts: d.unresolvedConflicts,
      lastPullAt: formatTimeOrNull(d.lastPullAt),
      lastPullCursor: opt(d.lastPullCursor),
      lastPushAt: formatTimeOrNull(d.lastPushAt),
    };
  }

  // -------------------------------------------------------------------------
  // Einzelne Push-Operation
  // -------------------------------------------------------------------------

  private async applyItem(p: Principal, index: number, item: Json): Promise<PushResult> {
    const base: PushResult = {
      index, operationId: rawString(item, 'operationId'), type: rawString(item, 'type'), id: rawString(item, 'id'),
      status: 'REJECTED', version: null, changeSeq: null, record: null, conflict: null, error: null, replayed: false,
    };
    let prepared: { opId: string | null; typ: string; id: string; hash: Buffer; run: Runner };
    try {
      prepared = this.prepare(p, item);
    } catch (err) {
      if (err instanceof ApiError) return rejectErr(base, err);
      throw err;
    }
    // Jede Operation in einer eigenen Transaktion: Schreibvorgang und Idempotenz-Eintrag sind atomar.
    return this.db.tx(async (c) => {
      if (prepared.opId) {
        await lockUser(c, p.userId); // gleichzeitige Wiederholungen derselben Operation nacheinander
        const stored = await ops.findOperation(c, p.userId, prepared.opId);
        if (stored) return replay(base, stored, prepared);
      }
      const result = await prepared.run(c, base);
      if (prepared.opId && (result.status === 'APPLIED' || result.status === 'CONFLICT')) {
        const stored: Record<string, unknown> = { status: result.status };
        if (result.version !== null) stored.version = result.version;
        if (result.changeSeq !== null) stored.changeSeq = result.changeSeq;
        if (result.conflict) {
          stored.conflictReason = result.conflict.reason;
          if (result.conflict.serverVersion !== null) stored.serverVersion = result.conflict.serverVersion;
        }
        await ops.insertOperation(c, p.userId, prepared.opId, p.deviceRef, prepared.typ, prepared.id, prepared.hash, stored);
      }
      return result;
    });
  }

  /** Validiert eine Operation vollständig, bevor eine Transaktion beginnt. */
  private prepare(p: Principal, item: Json) {
    const v = new Validator();
    const typeRaw = optString(item, 'type');
    const opRaw = optString(item, 'operation');
    v.check(typeRaw !== undefined, 'type', 'required');
    v.check(opRaw !== undefined, 'operation', 'required');
    const typ = v.enumValue('type', typeRaw, SYNC_TYPES, '') ?? '';
    const opName = v.enumValue('operation', opRaw, SYNC_OPERATIONS, '') ?? '';
    const id = v.uuid('id', optString(item, 'id'), true) ?? '';
    const opIdRaw = optString(item, 'operationId');
    const opId = opIdRaw !== undefined ? v.uuid('operationId', opIdRaw, true) : null;
    const baseVersion = optInt(item, 'baseVersion');
    if (baseVersion !== undefined) v.int('baseVersion', baseVersion, 1, 2 ** 31 - 1, 0, false);
    v.throwIfInvalid();
    if (opName === 'DELETE' && baseVersion === undefined) throw validationError([{ field: 'baseVersion', issue: 'required' }]);
    const meta = readMeta(item, v, p.deviceRef, opId);
    v.throwIfInvalid();
    const hash = requestHash(item);

    let run: Runner;
    if (typ === 'DAILY_REPORT') {
      run = this.prepareVersioned(this.reports.daily, p, opName, id, baseVersion, item, meta, readDailyValues,
        (r) => ({ version: r.version, changeSeq: r.changeSeq, deleted: r.deletedAt !== null, dto: dailyDto(r) }));
    } else if (typ === 'WEEKLY_REPORT') {
      run = this.prepareVersioned(this.reports.weekly, p, opName, id, baseVersion, item, meta, readWeeklyValues,
        (r) => ({ version: r.version, changeSeq: r.changeSeq, deleted: r.deletedAt !== null, dto: weeklyDto(r) }));
    } else { // PROFILE
      if (id !== p.userId) throw new ApiError(404, Codes.NotFound, 'Datensatz existiert nicht auf dem Server.');
      if (opName === 'DELETE') {
        throw validationError([{ field: 'operation', issue: 'profile_cannot_be_deleted' }]);
      }
      if (baseVersion === undefined) throw validationError([{ field: 'baseVersion', issue: 'required' }]);
      const pv = new Validator();
      const values = readProfileValues(data(item), pv);
      pv.throwIfInvalid();
      run = async (c, base) => toResult(base, await this.profiles.updateTx(c, p.userId, baseVersion, values),
        (r) => ({ version: r.version, changeSeq: r.changeSeq, deleted: false, dto: profileDto(r) }));
    }
    return { opId, typ, id, hash, run };
  }

  private prepareVersioned<V, R>(w: VersionedWriter<V, R>, p: Principal, op: string, id: string, base: number | undefined,
    item: Json, meta: WriteMeta, read: (o: Json, v: Validator) => V, describe: (r: R) => Described): Runner {
    if (op === 'DELETE') {
      return async (c, res) => toResult(res, await w.deleteTx(c, p.userId, id, base!, meta), describe);
    }
    const v = new Validator();
    const values = read(data(item), v);
    v.throwIfInvalid();
    if (base === undefined) return async (c, res) => toResult(res, await w.createTx(c, p.userId, id, values, meta), describe);
    return async (c, res) => toResult(res, await w.updateTx(c, p.userId, id, base, values, meta), describe);
  }
}

/** Die Nutzdaten einer Operation; fehlen sie, ist das ein Validierungsfehler. */
function data(item: Json): Json {
  const d = item.data;
  if (d === undefined || d === null) throw validationError([{ field: 'data', issue: 'required' }]);
  if (typeof d !== 'object' || Array.isArray(d)) {
    throw new ApiError(400, Codes.InvalidRequestBody, 'Die Daten haben eine ungültige Struktur.');
  }
  return d as Json;
}

function rawString(o: Json, key: string): string | null {
  const v = o[key];
  return typeof v === 'string' ? v : null;
}

/**
 * Prüfsumme des Inhalts einer Operation (erkennt Wiederverwendung einer operationId für eine andere Änderung).
 * Grundlage ist das geparste JSON – bei identischer Wiederholung durch das Gerät identisch.
 */
function requestHash(item: Json): Buffer {
  const canonical = JSON.stringify([item.type ?? null, item.operation ?? null, item.id ?? null, item.baseVersion ?? null,
    item.data ?? null, item.clientUpdatedAt ?? null, item.clientLocalId ?? null]);
  return createHash('sha256').update(canonical).digest();
}

/** Liefert das gespeicherte Ergebnis einer bereits verarbeiteten Operation. */
function replay(base: PushResult, stored: ops.StoredOperation, prepared: { typ: string; id: string; hash: Buffer }): PushResult {
  // Format 1 (gespeichert von Server 1.1): Prüfsumme aus anderer Berechnung – Typ und Datensatz vergleichen.
  const same = stored.hashFormat === 1
    ? stored.entityType === prepared.typ && stored.entityId === prepared.id
    : stored.requestHash.equals(prepared.hash);
  if (!same) {
    return { ...base, status: 'REJECTED', error: { code: Codes.OperationIdReused,
      message: 'Diese operationId wurde bereits für eine andere Änderung verwendet.' } };
  }
  const r = stored.result as { status: PushResult['status']; version?: number; changeSeq?: number;
    conflictReason?: ConflictReason; serverVersion?: number };
  return {
    ...base,
    status: r.status,
    version: r.version ?? null,
    changeSeq: r.changeSeq ?? null,
    conflict: r.conflictReason ? { reason: r.conflictReason, serverVersion: r.serverVersion ?? null, serverRecord: null } : null,
    replayed: true,
  };
}

function rejectErr(base: PushResult, err: ApiError): PushResult {
  const error: PushResult['error'] = { code: err.code, message: err.message };
  if (err.details) error.details = err.details;
  return { ...base, status: 'REJECTED', error };
}

function toResult<R>(base: PushResult, out: Outcome<R>, describe: (r: R) => Described): PushResult {
  if (out.kind === 'applied') {
    const d = describe(out.record);
    return { ...base, status: 'APPLIED', version: d.version, changeSeq: d.changeSeq, record: d.deleted ? null : d.dto };
  }
  if (out.kind === 'conflict') {
    const d = out.record ? describe(out.record) : null;
    return { ...base, status: 'CONFLICT',
      conflict: { reason: out.reason, serverVersion: d ? d.version : null, serverRecord: d && !d.deleted ? d.dto : null } };
  }
  return { ...base, status: 'REJECTED', error: { code: Codes.NotFound, message: 'Datensatz existiert nicht auf dem Server.' } };
}

function change(type: string, id: string, version: number, seq: number, deleted: boolean, updated: Date, dto: unknown): SyncChange {
  return { type, id, version, changeSeq: seq, deleted, updatedAt: formatTime(updated), data: deleted ? null : dto };
}

