// Registrierung, Login, Token-Erneuerung (Rotation), Logout, Passwortänderung und Sitzungen.

import { randomUUID } from 'node:crypto';
import type { Config } from '../config/config.ts';
import { ApiError, Codes, notFound, unauthorized, validationError } from '../domain/errors.ts';
import { formatTime } from '../domain/date.ts';
import { accountDto, type DeviceInfo, type User } from '../domain/models.ts';
import { type Database, isUniqueViolation, type Queryable } from '../db/pool.ts';
import * as users from '../db/repositories/users.ts';
import * as sessions from '../db/repositories/sessions.ts';
import { insertEmptyProfile } from '../db/repositories/reports.ts';
import type { PasswordHasher } from '../security/password.ts';
import { hashRefreshToken, InvalidTokenError, newRefreshToken, type Tokens } from '../security/tokens.ts';
import type { Logger } from '../util/logger.ts';
import { type Json, optObject, optString, Validator } from '../validation/validator.ts';

export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 128;
const EMAIL = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** Der authentifizierte Benutzer eines Requests (aus Token und aktiver Sitzung). */
export interface Principal {
  userId: string;
  sessionId: string;
  deviceRef: string | null;
}

export type AuthResponse = ReturnType<AuthService['buildResponse']>;

export class AuthService {
  private readonly db: Database;
  private readonly cfg: Config['auth'];
  readonly hasher: PasswordHasher;
  readonly tokens: Tokens;
  private readonly log: Logger;

  constructor(db: Database, cfg: Config['auth'], hasher: PasswordHasher, tokens: Tokens, log: Logger) {
    this.db = db;
    this.cfg = cfg;
    this.hasher = hasher;
    this.tokens = tokens;
    this.log = log;
  }

  async register(body: Json) {
    if (!this.cfg.registrationEnabled) {
      throw new ApiError(403, Codes.RegistrationDisabled, 'Die Registrierung ist auf diesem Server deaktiviert.');
    }
    const v = new Validator();
    const email = validEmail(v, optString(body, 'email'));
    const password = optString(body, 'password');
    if (password === undefined) v.add('password', 'required');
    else {
      const issue = passwordIssue(password, email);
      if (issue) v.add('password', issue);
    }
    const tz = v.timezone('timezone', optString(body, 'timezone')) ?? this.cfg.defaultTimezone;
    const device = validDevice(v, optObject(body, 'device'));
    v.throwIfInvalid();

    const hash = await this.hasher.hash(password!);
    const userId = randomUUID();
    try {
      const resp = await this.db.tx(async (c) => {
        await users.insertUser(c, userId, email, hash, tz);
        await insertEmptyProfile(c, userId);
        const user = (await users.findUserById(c, userId))!;
        return this.createSession(c, user, device, sessions.Events.Registered);
      });
      this.log.info('Neues Benutzerkonto registriert', { user_id: userId });
      return resp;
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ApiError(409, Codes.EmailAlreadyRegistered, 'Für diese E-Mail-Adresse existiert bereits ein Konto.');
      }
      throw err;
    }
  }

  async login(body: Json) {
    const v = new Validator();
    const email = validEmail(v, optString(body, 'email'));
    const password = v.text('password', optString(body, 'password'), { max: PASSWORD_MAX, required: true });
    const device = validDevice(v, optObject(body, 'device'));
    v.throwIfInvalid();

    const user = await users.findUserByEmail(this.db.pool, email);
    if (!user) {
      await this.hasher.verifyDummy(password!);
      await this.event(null, sessions.Events.LoginUnknownAccount, null, null);
      throw invalidCredentials();
    }
    if (user.locked) {
      throw new ApiError(429, Codes.AccountTemporarilyLocked,
        'Zu viele fehlgeschlagene Anmeldeversuche. Bitte später erneut versuchen.');
    }
    if (!(await this.hasher.verify(password!, user.passwordHash))) {
      await users.recordFailedLogin(this.db.pool, user.id, this.cfg.maxFailedLogins, this.cfg.lockoutSec);
      await this.event(user.id, sessions.Events.LoginFailed, null, null);
      const after = await users.findUserById(this.db.pool, user.id);
      if (after?.locked) {
        await this.event(user.id, sessions.Events.AccountLocked, null, null);
        this.log.warn('Konto nach Fehlversuchen vorübergehend gesperrt', { user_id: user.id });
      }
      this.log.info('Fehlgeschlagener Login', { user_id: user.id });
      throw invalidCredentials();
    }
    if (user.status !== 'ACTIVE') throw new ApiError(403, Codes.AccountDisabled, 'Dieses Konto ist deaktiviert.');
    const rehash = this.hasher.needsRehash(user.passwordHash) ? await this.hasher.hash(password!) : null;
    const resp = await this.db.tx(async (c) => {
      await users.recordSuccessfulLogin(c, user.id, rehash);
      return this.createSession(c, user, device, sessions.Events.LoginSucceeded);
    });
    this.log.info('Login erfolgreich', { user_id: user.id });
    return resp;
  }

  /**
   * Tauscht ein Refresh Token gegen ein neues Token-Paar (Rotation). Wird ein bereits benutztes Token
   * erneut vorgelegt, gilt die Sitzung als kompromittiert und wird widerrufen.
   */
  async refresh(body: Json) {
    const raw = optString(body, 'refreshToken');
    if (!raw) throw validationError([{ field: 'refreshToken', issue: 'required' }]);
    const hash = hashRefreshToken(raw);
    if (!hash) throw invalidRefreshToken();
    const resp = await this.db.tx(async (c) => {
      const row = await sessions.findRefreshTokenForUpdate(c, hash);
      if (!row) return null;
      if (row.used) {
        this.log.warn('Wiederverwendung eines Refresh Tokens erkannt – Sitzung widerrufen',
          { user_id: row.userId, session_id: row.sessionId });
        await sessions.revokeSession(c, row.sessionId, 'REFRESH_TOKEN_REUSE');
        await sessions.recordSecurityEvent(c, row.userId, sessions.Events.RefreshTokenReuse, row.sessionId, row.deviceRef);
        return null;
      }
      if (row.expired || !row.sessionActive || !row.userActive) return null;
      await sessions.markRefreshTokenUsed(c, row.tokenId, row.sessionId);
      const user = (await users.findUserById(c, row.userId))!;
      return this.issueTokens(c, user, row.sessionId);
    });
    if (!resp) throw invalidRefreshToken();
    return resp;
  }

  async logout(p: Principal) {
    await this.db.tx(async (c) => {
      await sessions.revokeSession(c, p.sessionId, 'LOGOUT');
      await sessions.recordSecurityEvent(c, p.userId, sessions.Events.Logout, p.sessionId, p.deviceRef);
    });
    this.log.info('Logout', { user_id: p.userId, session_id: p.sessionId });
  }

  /** Widerruft alle Sitzungen des Kontos auf allen Geräten (inklusive der aktuellen). */
  async logoutAll(p: Principal): Promise<number> {
    const n = await this.db.tx(async (c) => {
      const count = await sessions.revokeAllSessions(c, p.userId, null, 'LOGOUT_ALL');
      await sessions.recordSecurityEvent(c, p.userId, sessions.Events.LogoutAll, p.sessionId, p.deviceRef);
      return count;
    });
    this.log.info('Alle Sitzungen widerrufen', { user_id: p.userId, sessions: n });
    return n;
  }

  /** Neues Passwort; alle anderen Sitzungen werden widerrufen (Sicherheitsereignis). */
  async changePassword(p: Principal, body: Json) {
    const v = new Validator();
    const current = v.text('currentPassword', optString(body, 'currentPassword'), { max: PASSWORD_MAX, required: true });
    const next = optString(body, 'newPassword');
    if (next === undefined) v.add('newPassword', 'required');
    v.throwIfInvalid();
    const user = await users.findUserById(this.db.pool, p.userId);
    if (!user) throw unauthorized();
    const issue = passwordIssue(next!, user.email);
    if (issue) throw validationError([{ field: 'newPassword', issue }]);
    if (!(await this.hasher.verify(current!, user.passwordHash))) {
      await this.event(p.userId, sessions.Events.PasswordChangeFailed, p.sessionId, p.deviceRef);
      throw new ApiError(401, Codes.InvalidCredentials, 'Das aktuelle Passwort ist falsch.');
    }
    if (next === current) throw validationError([{ field: 'newPassword', issue: 'same_as_current' }]);
    const hash = await this.hasher.hash(next!);
    await this.db.tx(async (c) => {
      await users.updatePassword(c, p.userId, hash);
      const n = await sessions.revokeAllSessions(c, p.userId, p.sessionId, 'PASSWORD_CHANGED');
      this.log.info('Passwort geändert, andere Sitzungen widerrufen', { user_id: p.userId, sessions: n });
      await sessions.recordSecurityEvent(c, p.userId, sessions.Events.PasswordChanged, p.sessionId, p.deviceRef);
    });
  }

  listSessions(userId: string, limit: number, offset: number) {
    return sessions.listActiveSessions(this.db.pool, userId, limit, offset);
  }

  /** Beendet eine eigene Sitzung; fremde Sitzungs-IDs verhalten sich wie unbekannte. */
  async revokeSession(p: Principal, sessionId: string) {
    await this.db.tx(async (c) => {
      if (!(await sessions.revokeOwnSession(c, p.userId, sessionId, 'SESSION_REMOVED'))) throw notFound('Sitzung');
      await sessions.recordSecurityEvent(c, p.userId, sessions.Events.SessionRevoked, sessionId, null);
    });
  }

  /**
   * Prüft ein Access Token und zusätzlich, ob Sitzung und Konto noch aktiv sind (Logout und Sperren
   * wirken sofort). Aktualisiert "zuletzt aktiv" höchstens minütlich.
   */
  async authenticate(token: string): Promise<Principal | null> {
    let claims: { userId: string; sessionId: string };
    try {
      claims = this.tokens.parseAccessToken(token);
    } catch (err) {
      if (err instanceof InvalidTokenError) return null;
      throw err;
    }
    const s = await sessions.findActiveSession(this.db.pool, claims.sessionId, claims.userId);
    if (!s) return null;
    try {
      await sessions.touchActivity(this.db.pool, s.sessionId, s.deviceRef);
    } catch (err) {
      this.log.warn('Aktivitätszeitpunkt konnte nicht gespeichert werden', { error: (err as Error).message });
    }
    return { userId: s.userId, sessionId: s.sessionId, deviceRef: s.deviceRef };
  }

  private async createSession(c: Queryable, user: User, device: DeviceInfo | null, event: string) {
    const deviceRef = device ? await sessions.upsertDevice(c, user.id, device) : null;
    const sessionId = randomUUID();
    await sessions.createSession(c, sessionId, user.id, deviceRef, this.cfg.sessionMaxLifetimeSec);
    await sessions.recordSecurityEvent(c, user.id, event, sessionId, deviceRef);
    return this.issueTokens(c, user, sessionId);
  }

  private async issueTokens(c: Queryable, user: User, sessionId: string) {
    const refresh = newRefreshToken();
    const refreshExp = await sessions.insertRefreshToken(c, sessionId, hashRefreshToken(refresh)!, this.cfg.refreshTokenTtlSec);
    const access = this.tokens.issueAccessToken(user.id, sessionId);
    return this.buildResponse(user, access, refresh, refreshExp, sessionId);
  }

  buildResponse(user: User, access: { token: string; expiresAt: Date }, refresh: string, refreshExp: Date, sessionId: string) {
    return {
      account: accountDto(user),
      tokens: {
        tokenType: 'Bearer',
        accessToken: access.token,
        accessTokenExpiresAt: formatTime(access.expiresAt),
        expiresIn: this.tokens.ttlSec,
        refreshToken: refresh,
        refreshTokenExpiresAt: formatTime(refreshExp),
        sessionId,
      },
    };
  }

  /** Sicherheitsereignis außerhalb einer Transaktion; ein Fehler darf die eigentliche Antwort nicht ändern. */
  private async event(userId: string | null, type: string, sessionId: string | null, deviceRef: string | null) {
    try {
      await sessions.recordSecurityEvent(this.db.pool, userId, type, sessionId, deviceRef);
    } catch (err) {
      this.log.error('Sicherheitsereignis konnte nicht gespeichert werden', { event: type, error: (err as Error).message });
    }
  }
}

/** Fehlercode oder null für akzeptable Passwörter. */
export function passwordIssue(password: string, email: string): string | null {
  const chars = [...password];
  if (chars.length < PASSWORD_MIN) return `too_short:min=${PASSWORD_MIN}`;
  if (chars.length > PASSWORD_MAX) return `too_long:max=${PASSWORD_MAX}`;
  if (password.trim() === '') return 'blank';
  if (password.includes('\u0000') || !password.isWellFormed()) return 'invalid_characters';
  if (email && password.toLowerCase() === email.toLowerCase()) return 'equals_email';
  if (new Set(chars).size < 4) return 'too_simple';
  return null;
}

/** Normalisiert (trim, Kleinschreibung) und prüft eine E-Mail-Adresse. */
export function validEmail(v: Validator, raw: string | undefined): string {
  if (raw === undefined) {
    v.add('email', 'required');
    return '';
  }
  const email = raw.trim().toLowerCase();
  const local = email.split('@')[0];
  if (email.length > 254 || local.length > 64 || !EMAIL.test(email)) {
    v.add('email', 'invalid_email');
    return '';
  }
  return email;
}

/** Geräteangaben (Login, Registrierung, POST /devices). */
export function validDevice(v: Validator, d: Json | undefined): DeviceInfo | null {
  if (!d) return null;
  const id = v.uuid('device.id', optString(d, 'id'), true);
  const field = (key: string, max: number, def?: string) =>
    v.text(`device.${key}`, optString(d, key)?.trim(), { max, singleLine: true, def });
  const name = field('name', 100);
  const platform = field('platform', 32, 'ANDROID');
  const osVersion = field('osVersion', 32);
  const appVersion = field('appVersion', 32);
  if (!id || name === null || platform === null || osVersion === null || appVersion === null) return null;
  return { deviceId: id, name, platform: platform.toUpperCase(), osVersion, appVersion };
}

const invalidCredentials = () => new ApiError(401, Codes.InvalidCredentials, 'E-Mail-Adresse oder Passwort ist falsch.');
const invalidRefreshToken = () => new ApiError(401, Codes.InvalidRefreshToken,
  'Das Refresh Token ist ungültig, abgelaufen oder wurde widerrufen. Bitte erneut anmelden.');
