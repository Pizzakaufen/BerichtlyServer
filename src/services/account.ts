// Konto (Zeitzone, Sicherheitsereignisse), Profil und Geräteverwaltung.
// Jede Methode arbeitet ausschließlich mit der Benutzer-ID des authentifizierten Benutzers.

import { notFound } from '../domain/errors.ts';
import { type Profile, profileValuesEqual, type ProfileValues } from '../domain/models.ts';
import { type Database, lockUser, type Queryable } from '../db/pool.ts';
import * as users from '../db/repositories/users.ts';
import * as sessions from '../db/repositories/sessions.ts';
import { findProfile, updateProfile } from '../db/repositories/reports.ts';
import type { Logger } from '../util/logger.ts';
import { type Json, optString, Validator } from '../validation/validator.ts';
import { type Principal, validDevice } from './auth.ts';
import type { Outcome } from './versioned.ts';

export class AccountService {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  async get(userId: string) {
    const u = await users.findUserById(this.db.pool, userId);
    if (!u) throw notFound('Konto');
    return u;
  }

  async update(userId: string, body: Json) {
    const v = new Validator();
    const tz = v.timezone('timezone', optString(body, 'timezone'));
    v.throwIfInvalid();
    if (tz) await users.updateUserTimezone(this.db.pool, userId, tz);
    return this.get(userId);
  }

  securityEvents(userId: string, limit: number, offset: number) {
    return sessions.listSecurityEvents(this.db.pool, userId, limit, offset);
  }
}

export class ProfileService {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  async get(userId: string) {
    const p = await findProfile(this.db.pool, userId);
    if (!p) throw notFound('Profil');
    return p;
  }

  update(userId: string, base: number, v: ProfileValues) {
    return this.db.tx((c) => this.updateTx(c, userId, base, v));
  }

  /** Gleiche Konfliktregeln wie bei Berichten. */
  async updateTx(c: Queryable, userId: string, base: number, v: ProfileValues): Promise<Outcome<Profile>> {
    await lockUser(c, userId);
    const current = await findProfile(c, userId, true);
    if (!current) return { kind: 'notFound' };
    if (profileValuesEqual(current.values, v)) return { kind: 'applied', record: current, created: false, changed: false };
    if (current.version !== base) return { kind: 'conflict', record: current, reason: 'VERSION_MISMATCH' };
    const updated = await updateProfile(c, userId, base, v);
    return updated ? { kind: 'applied', record: updated, created: false, changed: true }
      : { kind: 'conflict', record: current, reason: 'VERSION_MISMATCH' };
  }
}

export class DeviceService {
  private readonly db: Database;
  private readonly log: Logger;

  constructor(db: Database, log: Logger) {
    this.db = db;
    this.log = log;
  }

  /**
   * Legt das Gerät an (oder aktiviert/aktualisiert es) und bindet die aktuelle Sitzung daran – für Apps,
   * die sich ohne Geräteangabe angemeldet haben. Alles in einer Transaktion.
   */
  async register(p: Principal, body: Json) {
    const v = new Validator();
    const info = validDevice(v, body);
    v.throwIfInvalid();
    return this.db.tx(async (c) => {
      const existing = await sessions.findDeviceByDeviceId(c, p.userId, info!.deviceId);
      const ref = await sessions.upsertDevice(c, p.userId, info!);
      await sessions.bindSessionToDevice(c, p.sessionId, ref);
      return { device: (await sessions.findDeviceByRef(c, p.userId, ref))!, created: !existing };
    });
  }

  list(userId: string, includeRevoked: boolean, limit: number, offset: number) {
    return sessions.listDevices(this.db.pool, userId, includeRevoked, limit, offset);
  }

  async get(userId: string, deviceId: string) {
    const d = await sessions.findDeviceByDeviceId(this.db.pool, userId, deviceId);
    if (!d) throw notFound('Gerät');
    return d;
  }

  async update(userId: string, deviceId: string, body: Json) {
    const v = new Validator();
    const field = (key: string, max: number) => {
      const raw = optString(body, key);
      if (raw === undefined) return undefined;
      return v.text(key, raw.trim(), { max, singleLine: true }) ?? undefined;
    };
    const u: sessions.DeviceUpdate = {
      name: field('name', 100), platform: field('platform', 32)?.toUpperCase(), osVersion: field('osVersion', 32),
      appVersion: field('appVersion', 32),
    };
    v.throwIfInvalid();
    if (!(await sessions.updateDevice(this.db.pool, userId, deviceId, u))) throw notFound('Gerät');
    return this.get(userId, deviceId);
  }

  /** Meldet ein Gerät ab: Sitzungen widerrufen, Gerät markieren, Ereignis speichern – atomar. Berichte bleiben. */
  async revoke(p: Principal, deviceId: string) {
    await this.db.tx(async (c) => {
      const d = await sessions.findDeviceByDeviceId(c, p.userId, deviceId);
      if (!d || d.revokedAt) throw notFound('Gerät');
      await sessions.revokeSessionsForDevice(c, p.userId, d.ref, 'DEVICE_REMOVED');
      await sessions.revokeDevice(c, p.userId, d.ref);
      await sessions.recordSecurityEvent(c, p.userId, sessions.Events.DeviceRevoked, p.sessionId, d.ref);
    });
    this.log.info('Gerät abgemeldet', { user_id: p.userId, device_id: deviceId });
  }
}
