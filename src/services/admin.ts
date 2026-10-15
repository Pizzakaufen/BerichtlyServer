// Admin-Dashboard (seit 2.0): Anmeldung, Sitzungen und protokollierte Verwaltungsaktionen.
//
// Grundsätze:
// - Anmelden können nur Konten mit der Rolle 'admin' (Vergabe ausschließlich per CLI), Status ACTIVE.
// - Fehlversuche zählen wie bei der App-Anmeldung und sperren das Konto vorübergehend.
// - Das Sitzungs-Cookie ist 32 zufällige Bytes; gespeichert wird nur dessen SHA-256-Hash.
// - Jede verändernde Aktion wird mit Admin, Aktion und Ziel im Audit-Protokoll festgehalten – ohne Inhalte.

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Config } from '../config/config.ts';
import type { Database } from '../db/pool.ts';
import * as admin from '../db/repositories/admin.ts';
import * as sessions from '../db/repositories/sessions.ts';
import * as users from '../db/repositories/users.ts';
import type { PasswordHasher } from '../security/password.ts';
import type { Logger } from '../util/logger.ts';

export interface AdminPrincipal {
  sessionId: string;
  userId: string;
  email: string;
  csrfToken: string;
}

export type AdminLoginResult =
  | { ok: true; cookie: string; principal: AdminPrincipal }
  | { ok: false; reason: 'INVALID' | 'LOCKED' };

export const AdminActions = {
  Login: 'ADMIN_LOGIN',
  Logout: 'ADMIN_LOGOUT',
  DisableUser: 'USER_DISABLED',
  EnableUser: 'USER_ENABLED',
  RevokeSessions: 'USER_SESSIONS_REVOKED',
  RevokeDevice: 'DEVICE_REVOKED',
} as const;

export const hashToken = (raw: string) => createHash('sha256').update(raw, 'utf8').digest();

/** Konstante Vergleichszeit für CSRF-Tokens. */
export function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export class AdminService {
  private readonly db: Database;
  private readonly cfg: Config;
  private readonly hasher: PasswordHasher;
  private readonly log: Logger;

  constructor(db: Database, cfg: Config, hasher: PasswordHasher, log: Logger) {
    this.db = db;
    this.cfg = cfg;
    this.hasher = hasher;
    this.log = log;
  }

  async login(emailRaw: string, password: string): Promise<AdminLoginResult> {
    const email = emailRaw.trim().toLowerCase();
    if (!email || !password || password.length > 128 || email.length > 254) return { ok: false, reason: 'INVALID' };
    const user = await users.findUserByEmail(this.db.pool, email);
    if (!user) {
      await this.hasher.verifyDummy(password);
      return { ok: false, reason: 'INVALID' };
    }
    if (user.locked) return { ok: false, reason: 'LOCKED' };
    const valid = await this.hasher.verify(password, user.passwordHash);
    const role = await admin.findRole(this.db.pool, user.id);
    if (!valid) {
      await users.recordFailedLogin(this.db.pool, user.id, this.cfg.auth.maxFailedLogins, this.cfg.auth.lockoutSec);
      await sessions.recordSecurityEvent(this.db.pool, user.id, 'ADMIN_LOGIN_FAILED', null, null);
      this.log.warn('Admin-Anmeldung fehlgeschlagen', { user_id: user.id });
      return { ok: false, reason: 'INVALID' };
    }
    // Gleiche Antwort wie bei falschem Passwort: verrät nicht, ob ein Konto Administrator ist.
    if (role !== 'admin' || user.status !== 'ACTIVE') {
      await sessions.recordSecurityEvent(this.db.pool, user.id, 'ADMIN_LOGIN_DENIED', null, null);
      this.log.warn('Admin-Anmeldung ohne Berechtigung abgelehnt', { user_id: user.id });
      return { ok: false, reason: 'INVALID' };
    }
    const raw = randomBytes(32).toString('base64url');
    const csrf = randomBytes(32).toString('base64url');
    const id = randomUUID();
    await this.db.tx(async (c) => {
      await users.recordSuccessfulLogin(c, user.id, null);
      await admin.insertSession(c, id, user.id, hashToken(raw), csrf, this.cfg.admin.sessionMaxSec);
      await admin.audit(c, user.id, AdminActions.Login, null, null);
    });
    this.log.info('Admin-Anmeldung', { user_id: user.id });
    return { ok: true, cookie: raw, principal: { sessionId: id, userId: user.id, email: user.email, csrfToken: csrf } };
  }

  async authenticate(cookie: string | undefined): Promise<AdminPrincipal | null> {
    if (!cookie || !/^[A-Za-z0-9_-]{43}$/.test(cookie)) return null;
    const row = await admin.touchSession(this.db.pool, hashToken(cookie), this.cfg.admin.sessionIdleSec);
    return row ? { sessionId: row.id, userId: row.userId, email: row.email, csrfToken: row.csrfToken } : null;
  }

  async logout(p: AdminPrincipal) {
    await this.db.tx(async (c) => {
      await admin.revokeSession(c, p.sessionId);
      await admin.audit(c, p.userId, AdminActions.Logout, null, null);
    });
  }

  /** Konto sperren (alle App-Sitzungen werden beendet) bzw. wieder freigeben. Eigenes Konto nie. */
  async setUserStatus(p: AdminPrincipal, userId: string, active: boolean): Promise<'OK' | 'SELF' | 'NOT_FOUND'> {
    if (userId === p.userId) return 'SELF';
    return this.db.tx(async (c) => {
      if (!(await admin.setUserStatus(c, userId, active ? 'ACTIVE' : 'DISABLED'))) return 'NOT_FOUND';
      if (!active) await sessions.revokeAllSessions(c, userId, null, 'ADMIN_ACTION');
      await admin.audit(c, p.userId, active ? AdminActions.EnableUser : AdminActions.DisableUser, userId, null);
      this.log.warn(active ? 'Konto durch Admin freigegeben' : 'Konto durch Admin gesperrt', { user_id: userId, admin_id: p.userId });
      return 'OK';
    });
  }

  /** Alle App-Sitzungen eines Kontos beenden (z. B. bei Verlust eines Geräts). Daten bleiben unverändert. */
  async revokeSessions(p: AdminPrincipal, userId: string) {
    await this.db.tx(async (c) => {
      await sessions.revokeAllSessions(c, userId, null, 'ADMIN_ACTION');
      await admin.audit(c, p.userId, AdminActions.RevokeSessions, userId, null);
    });
  }

  /** Gerät abmelden: Sitzungen des Geräts beenden und Gerät als widerrufen markieren. Berichte bleiben erhalten. */
  async revokeDevice(p: AdminPrincipal, userId: string, deviceRef: string) {
    await this.db.tx(async (c) => {
      await sessions.revokeSessionsForDevice(c, userId, deviceRef, 'ADMIN_ACTION');
      await sessions.revokeDevice(c, userId, deviceRef);
      await admin.audit(c, p.userId, AdminActions.RevokeDevice, userId, deviceRef);
    });
  }
}
