// Zentrale Schreibregeln mit optimistischer Sperre (siehe docs/SYNC.md) – für REST und Synchronisierung gleich:
//  - Erstellen mit bereits verwendeter ID überschreibt nie; identischer Inhalt = idempotente Wiederholung.
//  - Ändern/Löschen nur, wenn die Basisversion des Clients der Serverversion entspricht.
//  - Konflikte liefern den aktuellen Serverstand, statt Daten stillschweigend zu überschreiben (kein Last-Write-Wins).
//  - Schreibvorgänge eines Kontos werden über eine Zeilensperre serialisiert, damit Änderungsnummern in
//    Commit-Reihenfolge vergeben werden.

import { type ConflictReason, conflictError, notFound } from '../domain/errors.ts';
import type { WriteMeta } from '../domain/models.ts';
import { type Database, lockUser, type Queryable } from '../db/pool.ts';
import type { VersionedStore } from '../db/repositories/reports.ts';

export type Outcome<R> =
  | { kind: 'applied'; record: R; created: boolean; changed: boolean }
  | { kind: 'conflict'; record: R | null; reason: ConflictReason }
  | { kind: 'notFound' };

const applied = <R>(record: R, created = false, changed = false): Outcome<R> => ({ kind: 'applied', record, created, changed });
const conflict = <R>(record: R | null, reason: ConflictReason): Outcome<R> => ({ kind: 'conflict', record, reason });

export class VersionedWriter<V, R> {
  private readonly db: Database;
  readonly store: VersionedStore<V, R>;

  constructor(db: Database, store: VersionedStore<V, R>) {
    this.db = db;
    this.store = store;
  }

  create(userId: string, id: string, v: V, m: WriteMeta) {
    return this.db.tx((c) => this.createTx(c, userId, id, v, m));
  }

  update(userId: string, id: string, base: number, v: V, m: WriteMeta) {
    return this.db.tx((c) => this.updateTx(c, userId, id, base, v, m));
  }

  delete(userId: string, id: string, base: number, m: WriteMeta) {
    return this.db.tx((c) => this.deleteTx(c, userId, id, base, m));
  }

  async createTx(c: Queryable, userId: string, id: string, v: V, m: WriteMeta): Promise<Outcome<R>> {
    await lockUser(c, userId);
    const existing = await this.store.findById(c, id, true);
    if (existing) {
      if (this.store.owner(existing) !== userId) return conflict<R>(null, 'ID_UNAVAILABLE');
      if (this.store.deleted(existing)) return conflict(existing, 'DELETED_ON_SERVER');
      if (this.store.same(existing, v)) return applied(existing);
      return conflict(existing, 'ALREADY_EXISTS');
    }
    const collision = await this.store.findCollision(c, userId, id, v);
    if (collision) return conflict(collision, 'DUPLICATE_WEEK');
    return applied(await this.store.insert(c, userId, id, v, m), true, true);
  }

  async updateTx(c: Queryable, userId: string, id: string, base: number, v: V, m: WriteMeta): Promise<Outcome<R>> {
    const existing = await this.lockOwned(c, userId, id);
    if (!existing) return { kind: 'notFound' };
    if (this.store.deleted(existing)) return conflict(existing, 'DELETED_ON_SERVER');
    if (this.store.same(existing, v)) return applied(existing);
    if (this.store.version(existing) !== base) return conflict(existing, 'VERSION_MISMATCH');
    const collision = await this.store.findCollision(c, userId, id, v);
    if (collision) return conflict(collision, 'DUPLICATE_WEEK');
    const updated = await this.store.update(c, id, base, v, m);
    return updated ? applied(updated, false, true) : conflict(existing, 'VERSION_MISMATCH');
  }

  async deleteTx(c: Queryable, userId: string, id: string, base: number, m: WriteMeta): Promise<Outcome<R>> {
    const existing = await this.lockOwned(c, userId, id);
    if (!existing) return { kind: 'notFound' };
    if (this.store.deleted(existing)) return applied(existing); // idempotent
    if (this.store.version(existing) !== base) return conflict(existing, 'VERSION_MISMATCH');
    const deleted = await this.store.softDelete(c, id, base, m);
    return deleted ? applied(deleted, false, true) : conflict(existing, 'VERSION_MISMATCH');
  }

  /** Sperrt Benutzer und Datensatz; fremde Datensätze verhalten sich wie nicht vorhandene. */
  private async lockOwned(c: Queryable, userId: string, id: string): Promise<R | null> {
    await lockUser(c, userId);
    const existing = await this.store.findById(c, id, true);
    return existing && this.store.owner(existing) === userId ? existing : null;
  }
}

/** Übersetzt ein Ergebnis für REST: Konflikt → 409 mit Serverstand, nicht gefunden → 404. */
export function requireApplied<R>(out: Outcome<R>, what: string, version: (r: R) => number, dto: (r: R) => unknown) {
  if (out.kind === 'applied') return out;
  if (out.kind === 'conflict') {
    throw conflictError({
      reason: out.reason,
      serverVersion: out.record ? version(out.record) : null,
      serverRecord: out.record ? dto(out.record) : null,
    });
  }
  throw notFound(what);
}
