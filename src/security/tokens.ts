// Access Tokens: JWT mit HS256 (ausschließlich – "none" und andere Algorithmen werden abgelehnt).
// Refresh Tokens: 256 Bit Zufall, nur als SHA-256-Hash gespeichert.
// Format und Claims sind identisch mit Berichtly Server 1.1 (Tokens bleiben beim Upgrade gültig).

import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

const REFRESH_PREFIX = 'brt_';
const LEEWAY_SEC = 5;
const HEADER = b64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));

function b64url(b: Buffer) {
  return b.toString('base64url');
}

export class InvalidTokenError extends Error {}

export interface TokenOptions {
  secret: Buffer;
  issuer: string;
  audience: string;
  ttlSec: number;
  now: () => Date;
}

export class Tokens {
  private readonly o: TokenOptions;

  constructor(o: TokenOptions) {
    this.o = o;
  }

  get ttlSec() {
    return this.o.ttlSec;
  }

  issueAccessToken(userId: string, sessionId: string): { token: string; expiresAt: Date } {
    const now = Math.floor(this.o.now().getTime() / 1000);
    const exp = now + this.o.ttlSec;
    const payload = {
      sid: sessionId, iss: this.o.issuer, sub: userId, aud: [this.o.audience], exp, nbf: now, iat: now, jti: randomUUID(),
    };
    const body = `${HEADER}.${b64url(Buffer.from(JSON.stringify(payload)))}`;
    const sig = b64url(createHmac('sha256', this.o.secret).update(body).digest());
    return { token: `${body}.${sig}`, expiresAt: new Date(exp * 1000) };
  }

  /**
   * Prüft Signatur (nur HS256), Aussteller, Zielgruppe, Ablauf, "nicht vor" und Ausstellungszeit
   * gegen die echte Uhr. Liefert Benutzer- und Sitzungs-ID.
   */
  parseAccessToken(raw: string): { userId: string; sessionId: string } {
    const parts = raw.split('.');
    if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]*$/.test(p))) throw new InvalidTokenError();
    let header: Record<string, unknown>;
    let payload: Record<string, unknown>;
    try {
      header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
      payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    } catch {
      throw new InvalidTokenError();
    }
    if (header.alg !== 'HS256') throw new InvalidTokenError();
    const expected = createHmac('sha256', this.o.secret).update(`${parts[0]}.${parts[1]}`).digest();
    const actual = Buffer.from(parts[2], 'base64url');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new InvalidTokenError();

    const now = Date.now() / 1000;
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const exp = num(payload.exp);
    if (exp === null || now > exp + LEEWAY_SEC) throw new InvalidTokenError();
    const nbf = num(payload.nbf);
    if (payload.nbf !== undefined && (nbf === null || now < nbf - LEEWAY_SEC)) throw new InvalidTokenError();
    const iat = num(payload.iat);
    if (payload.iat !== undefined && (iat === null || now < iat - LEEWAY_SEC)) throw new InvalidTokenError();
    if (payload.iss !== this.o.issuer) throw new InvalidTokenError();
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!aud.includes(this.o.audience)) throw new InvalidTokenError();
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (typeof payload.sub !== 'string' || !uuid.test(payload.sub)) throw new InvalidTokenError();
    if (typeof payload.sid !== 'string' || !uuid.test(payload.sid)) throw new InvalidTokenError();
    return { userId: payload.sub.toLowerCase(), sessionId: payload.sid.toLowerCase() };
  }
}

/** Neues Refresh Token (Präfix "brt_" erleichtert Secret-Scanning). */
export const newRefreshToken = () => REFRESH_PREFIX + randomBytes(32).toString('base64url');

/** SHA-256-Hash oder null für offensichtlich fremde Werte. */
export function hashRefreshToken(token: string): Buffer | null {
  if (token.length !== REFRESH_PREFIX.length + 43 || !token.startsWith(REFRESH_PREFIX)) return null;
  return createHash('sha256').update(token).digest();
}
