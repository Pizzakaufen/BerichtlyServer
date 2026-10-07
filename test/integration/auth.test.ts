import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, test } from 'node:test';
import { Tokens } from '../../src/security/tokens.ts';
import { DEFAULT_PASSWORD, type Env, needsDb, newEnv, uuid } from '../helpers.ts';

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');

function signHs256(claims: Record<string, unknown>, secret: string | Buffer) {
  const head = b64({ alg: 'HS256', typ: 'JWT' }) + '.' + b64(claims);
  return head + '.' + createHmac('sha256', secret).update(head).digest('base64url');
}

const tokensFor = (e: Env, now: () => Date) => {
  const a = e.app.cfg.auth;
  return new Tokens({ secret: a.jwtSecret, issuer: a.issuer, audience: a.audience, ttlSec: a.accessTokenTtlSec, now });
};

describe('Authentifizierung', needsDb, () => {
  test('Registrierung speichert nur Argon2-Hash', async () => {
    const e = await newEnv();
    const r = (await e.post('/api/v1/auth/register', '', { email: '  Anna.Muster@Example.ORG ', password: DEFAULT_PASSWORD })).expect(201);
    assert.equal(r.data.account.email, 'anna.muster@example.org');
    assert.equal(r.data.account.timezone, 'Europe/Berlin');
    assert.equal(r.data.tokens.tokenType, 'Bearer');
    const refresh: string = r.data.tokens.refreshToken;
    assert.match(refresh, /^brt_[A-Za-z0-9_-]{43}$/);

    const { rows } = await e.db.query('SELECT password_hash FROM users WHERE email = $1', ['anna.muster@example.org']);
    assert.ok(rows[0].password_hash.startsWith('$argon2id$v=19$'));
    assert.ok(!rows[0].password_hash.includes(DEFAULT_PASSWORD));
    const plain = await e.db.query('SELECT count(*) AS n FROM refresh_tokens WHERE position($1::bytea IN token_hash) > 0',
      [Buffer.from(refresh)]);
    assert.equal(plain.rows[0].n, 0, 'Refresh Token im Klartext gespeichert');
  });

  test('doppelte E-Mail wird abgelehnt', async () => {
    const e = await newEnv();
    await e.register('doppelt@example.org');
    const r = (await e.post('/api/v1/auth/register', '', { email: 'DOPPELT@example.org', password: DEFAULT_PASSWORD })).expect(409);
    assert.equal(r.code, 'EMAIL_ALREADY_REGISTERED');
  });

  test('ungültige Registrierungsdaten', async () => {
    const e = await newEnv();
    const r = (await e.post('/api/v1/auth/register', '', { email: 'keine-mail', password: 'kurz', timezone: 'Mars/Olympus' })).expect(422);
    for (const f of ['email', 'password', 'timezone']) assert.ok(r.fields.includes(f), `Fehler für ${f} fehlt: ${r.raw}`);
    (await e.post('/api/v1/auth/register', '', {})).expect(422);
    (await e.post('/api/v1/auth/register', '', { email: 'gleich@example.org', password: 'gleich@example.org' })).expect(422);
  });

  test('ungültiges JSON ohne interne Details', async () => {
    const e = await newEnv();
    let r = (await e.post('/api/v1/auth/login', '', '{"email": ')).expect(400);
    assert.equal(r.code, 'INVALID_REQUEST_BODY');
    assert.ok(!/JSON at position|Unexpected|SyntaxError/.test(r.raw), r.raw);
    r = (await e.post('/api/v1/auth/login', '', '{"email": 5}')).expect(400);
    assert.equal(r.code, 'INVALID_REQUEST_BODY');
    r = (await e.post('/api/v1/auth/login', '', '[1,2]')).expect(400);
    assert.equal(r.code, 'INVALID_REQUEST_BODY');
    r = (await e.post('/api/v1/auth/login', '', '{"__proto__": {"admin": true}}')).expect(400);
    assert.equal(r.code, 'INVALID_REQUEST_BODY');
  });

  test('Login: gleicher Fehler für falsches Passwort und unbekannte E-Mail', async () => {
    const e = await newEnv();
    await e.register('login@example.org');
    (await e.login('login@example.org', DEFAULT_PASSWORD)).expect(200);
    assert.equal((await e.login('login@example.org', 'falsches-Passwort-123')).expect(401).code, 'INVALID_CREDENTIALS');
    assert.equal((await e.login('niemand@example.org', DEFAULT_PASSWORD)).expect(401).code, 'INVALID_CREDENTIALS');
  });

  test('Kontosperre nach Fehlversuchen', async () => {
    const e = await newEnv();
    await e.register('brute@example.org');
    for (let i = 0; i < 5; i++) (await e.login('brute@example.org', 'falsch-falsch-123')).expect(401);
    assert.equal((await e.login('brute@example.org', DEFAULT_PASSWORD)).expect(429).code, 'ACCOUNT_TEMPORARILY_LOCKED');
  });

  test('Rate Limit für Auth-Endpunkte', async () => {
    const e = await newEnv({ overrides: { RATE_LIMIT_AUTH_PER_MINUTE: '3' } });
    for (let i = 0; i < 3; i++) await e.login('limit@example.org', DEFAULT_PASSWORD);
    const r = (await e.login('limit@example.org', DEFAULT_PASSWORD)).expect(429);
    assert.equal(r.code, 'RATE_LIMITED');
    assert.ok(Number(r.headers.get('retry-after')) >= 1);
    (await e.get('/api/v1/health')).expect(200); // andere Endpunkte sind nicht betroffen
  });

  test('Registrierung abschaltbar', async () => {
    const e = await newEnv({ overrides: { REGISTRATION_ENABLED: 'false' } });
    const r = (await e.post('/api/v1/auth/register', '', { email: 'neu@example.org', password: DEFAULT_PASSWORD })).expect(403);
    assert.equal(r.code, 'REGISTRATION_DISABLED');
  });

  test('Refresh rotiert und erkennt Wiederverwendung', async () => {
    const e = await newEnv();
    const s = await e.register();
    const rotated = (await e.post('/api/v1/auth/refresh', '', { refreshToken: s.refresh })).expect(200).session();
    assert.notEqual(rotated.refresh, s.refresh);
    assert.equal(rotated.sessionId, s.sessionId);
    (await e.get('/api/v1/account', rotated.access)).expect(200);

    // Altes Token erneut verwenden → Sitzung wird vollständig widerrufen.
    assert.equal((await e.post('/api/v1/auth/refresh', '', { refreshToken: s.refresh })).expect(401).code, 'INVALID_REFRESH_TOKEN');
    (await e.post('/api/v1/auth/refresh', '', { refreshToken: rotated.refresh })).expect(401);
    (await e.get('/api/v1/account', rotated.access)).expect(401);
  });

  test('ungültige Refresh Tokens', async () => {
    const e = await newEnv();
    (await e.post('/api/v1/auth/refresh', '', {})).expect(422);
    (await e.post('/api/v1/auth/refresh', '', { refreshToken: 'abc' })).expect(401);
    (await e.post('/api/v1/auth/refresh', '', { refreshToken: 'brt_' + 'A'.repeat(43) })).expect(401);
  });

  test('Logout widerruft Tokens sofort', async () => {
    const e = await newEnv();
    const s = await e.register();
    (await e.post('/api/v1/auth/logout', s.access)).expect(204);
    (await e.get('/api/v1/profile', s.access)).expect(401);
    (await e.post('/api/v1/auth/refresh', '', { refreshToken: s.refresh })).expect(401);
  });

  test('fehlende, ungültige, fremde und abgelaufene Tokens', async () => {
    const e = await newEnv();
    const s = await e.register();

    const r = (await e.get('/api/v1/daily-reports')).expect(401);
    assert.equal(r.code, 'UNAUTHORIZED');
    assert.ok(r.headers.get('www-authenticate'));
    (await e.get('/api/v1/daily-reports', 'kein.jwt.token')).expect(401);
    (await e.get('/api/v1/daily-reports', '', { Authorization: `Basic ${s.access}` })).expect(401);

    const now = Math.floor(Date.now() / 1000);
    const claims = { iss: 'berichtly-server', aud: 'berichtly-app', sub: s.userId, sid: s.sessionId, iat: now, exp: now + 600 };
    // Fremd signiert
    (await e.get('/api/v1/daily-reports', signHs256(claims, 'ein-anderes-geheimnis-mit-ausreichender-laenge-123'))).expect(401);
    // Algorithmus "none" wird nie akzeptiert
    (await e.get('/api/v1/daily-reports', b64({ alg: 'none', typ: 'JWT' }) + '.' + b64(claims) + '.')).expect(401);
    // Richtiges Geheimnis, aber falscher Algorithmus im Header
    const hs512Head = b64({ alg: 'HS512', typ: 'JWT' }) + '.' + b64(claims);
    (await e.get('/api/v1/daily-reports',
      hs512Head + '.' + createHmac('sha256', e.app.cfg.auth.jwtSecret).update(hs512Head).digest('base64url'))).expect(401);

    // Abgelaufen (mit 2 Stunden alter Uhr ausgestellt)
    const expired = tokensFor(e, () => new Date(Date.now() - 2 * 3600_000)).issueAccessToken(s.userId, s.sessionId).token;
    (await e.get('/api/v1/daily-reports', expired)).expect(401);
    // Gültige Signatur, aber unbekannte Sitzung
    const unknown = tokensFor(e, () => new Date()).issueAccessToken(s.userId, uuid()).token;
    (await e.get('/api/v1/daily-reports', unknown)).expect(401);

    (await e.get('/api/v1/daily-reports', s.access)).expect(200);
  });

  test('Konto-Zeitzone ändern', async () => {
    const e = await newEnv();
    const s = await e.register();
    assert.equal((await e.patch('/api/v1/account', s.access, { timezone: 'Europe/Vienna' })).expect(200).data.timezone, 'Europe/Vienna');
    (await e.patch('/api/v1/account', s.access, { timezone: 'UTC+2' })).expect(422);
  });
});
