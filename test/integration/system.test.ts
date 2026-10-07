import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { latestSchemaVersion, migrate, schemaVersion } from '../../src/db/migrate.ts';
import { silentLogger } from '../../src/util/logger.ts';
import { needsDb, newEnv, STATUS_TOKEN, uuid } from '../helpers.ts';

describe('System: Health, Fehlerformat, Header, Grenzen, Datenbank', needsDb, () => {
  test('Health-Check ohne sensible Informationen', async () => {
    const e = await newEnv();
    const r = (await e.get('/api/v1/health')).expect(200);
    assert.equal(r.data.status, 'ok');
    assert.equal(r.data.components.database, 'up');
    for (const secret of ['postgres', 'version', 'node', 'heap', '127.0.0.1']) {
      assert.ok(!r.raw.toLowerCase().includes(secret), `Health-Check verrät "${secret}": ${r.raw}`);
    }
    assert.ok(r.headers.get('x-request-id'));
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
    assert.equal(r.headers.get('server'), null);
    assert.equal(r.headers.get('x-powered-by'), null);
    (await e.get('/api/v1/health/live')).expect(200);
  });

  test('Request-ID, unbekannte Endpunkte und falsche Methoden', async () => {
    const e = await newEnv();
    const r = (await e.get('/api/v1/gibt-es-nicht', '', { 'X-Request-ID': 'android-req-12345' })).expect(404);
    assert.equal(r.headers.get('x-request-id'), 'android-req-12345');
    assert.equal(r.code, 'NOT_FOUND');
    assert.equal(r.body.error.requestId, 'android-req-12345');
    const replaced = await e.get('/api/v1/health', '', { 'X-Request-ID': '<script>' });
    assert.match(replaced.headers.get('x-request-id') ?? '', /^[0-9a-f-]{36}$/);
    const m = (await e.request('DELETE', '/api/v1/health')).expect(405);
    assert.equal(m.code, 'METHOD_NOT_ALLOWED');
    assert.match(m.headers.get('allow') ?? '', /GET/);
    (await e.request('PATCH', `/api/v1/daily-reports/${uuid()}`)).expect(405);
    (await e.get('/api/v1/health/')).expect(404); // keine stillen Varianten
    (await e.get('/')).expect(404);
  });

  test('interner Status nur mit Token', async () => {
    const e = await newEnv();
    (await e.get('/internal/status')).expect(404);
    (await e.get('/internal/status', 'falsches-token')).expect(404);
    const r = (await e.get('/internal/status', STATUS_TOKEN)).expect(200);
    assert.equal(r.data.database.state, 'UP');
    assert.equal(r.data.database.schemaVersion, latestSchemaVersion());
    assert.ok(r.data.metrics.requestsTotal >= 1);
    assert.ok(r.data.database.poolMax >= 1);

    const off = await newEnv({ overrides: { INTERNAL_STATUS_TOKEN: '' } });
    (await off.get('/internal/status', STATUS_TOKEN)).expect(404);
  });

  test('API-Dokumentation abschaltbar', async () => {
    const e = await newEnv();
    assert.match((await e.get('/api/openapi.yaml')).expect(200).raw, /openapi: 3/);
    (await e.get('/api/docs')).expect(200);
    const off = await newEnv({ overrides: { API_DOCS_ENABLED: 'false' } });
    (await off.get('/api/openapi.yaml')).expect(404);
    (await off.get('/api/docs')).expect(404);
  });

  test('zu große und falsch typisierte Requests', async () => {
    const e = await newEnv({ overrides: { MAX_REQUEST_BODY_BYTES: '2048' } });
    const tok = (await e.register()).access;
    const big = (await e.post('/api/v1/daily-reports', tok, { date: '2026-10-05', text: 'x'.repeat(5000) })).expect(413);
    assert.equal(big.code, 'PAYLOAD_TOO_LARGE');
    const plain = (await e.request('POST', '/api/v1/daily-reports', tok, undefined, { 'Content-Type': 'text/plain' })).expect(415);
    assert.equal(plain.code, 'UNSUPPORTED_MEDIA_TYPE');
    (await e.request('POST', '/api/v1/daily-reports', tok, undefined, { 'Content-Type': 'application/json' })).expect(400);
    // Content-Type mit Zeichensatz ist erlaubt.
    (await e.request('POST', '/api/v1/daily-reports', tok, JSON.stringify({ date: '2026-10-05', text: 'ok' }),
      { 'Content-Type': 'application/json; charset=utf-8' })).expect(201);
  });

  test('CORS standardmäßig aus, sonst nur für erlaubte Origins', async () => {
    const e = await newEnv();
    assert.equal((await e.get('/api/v1/health', '', { Origin: 'https://evil.example' })).headers.get('access-control-allow-origin'), null);
    const c = await newEnv({ overrides: { CORS_ALLOWED_ORIGINS: 'https://app.berichtly.example' } });
    assert.equal((await c.get('/api/v1/health', '', { Origin: 'https://app.berichtly.example' })).headers.get('access-control-allow-origin'),
      'https://app.berichtly.example');
    assert.equal((await c.get('/api/v1/health', '', { Origin: 'https://evil.example' })).headers.get('access-control-allow-origin'), null);
    const pre = await c.request('OPTIONS', '/api/v1/daily-reports', '', undefined,
      { Origin: 'https://app.berichtly.example', 'Access-Control-Request-Method': 'POST' });
    assert.equal(pre.status, 204);
    assert.match(pre.headers.get('access-control-allow-headers') ?? '', /Authorization/);
  });

  test('Client-IP hinter dem Proxy: Rate Limit pro X-Forwarded-For-Adresse', async () => {
    const e = await newEnv({ overrides: { TRUST_PROXY: 'true', RATE_LIMIT_API_PER_MINUTE: '2' } });
    for (let i = 0; i < 2; i++) (await e.get('/api/v1/health/live', '', { 'X-Forwarded-For': '203.0.113.7' })).expect(200);
    (await e.get('/api/v1/health/live', '', { 'X-Forwarded-For': '203.0.113.7' })).expect(429);
    // Nginx hängt die echte Adresse an; ein vom Client gefälschter erster Eintrag zählt nicht.
    (await e.get('/api/v1/health/live', '', { 'X-Forwarded-For': '203.0.113.7, 198.51.100.9' })).expect(200);

    // Ohne TRUST_PROXY wird X-Forwarded-For ignoriert (alle Anfragen kommen von 127.0.0.1).
    const direct = await newEnv({ overrides: { RATE_LIMIT_API_PER_MINUTE: '2' } });
    (await direct.get('/api/v1/health/live', '', { 'X-Forwarded-For': '203.0.113.1' })).expect(200);
    (await direct.get('/api/v1/health/live', '', { 'X-Forwarded-For': '203.0.113.2' })).expect(200);
    (await direct.get('/api/v1/health/live', '', { 'X-Forwarded-For': '203.0.113.3' })).expect(429);
  });

  // Datenbank-Integration: Constraints, Trigger und Kaskaden direkt in PostgreSQL.
  test('Datenbank-Constraints und Trigger', async () => {
    const e = await newEnv();
    const user = uuid();
    const insertUser = "INSERT INTO users (id, email, password_hash, timezone) VALUES ($1, $2, 'x', 'Europe/Berlin')";
    await e.db.query(insertUser, [user, 'x@example.org']);
    await assert.rejects(e.db.query(insertUser, [uuid(), 'x@example.org']), 'doppelte E-Mail akzeptiert');
    await assert.rejects(e.db.query(insertUser, [uuid(), 'Gross@example.org']), 'nicht normalisierte E-Mail akzeptiert');
    const insertWeek = `INSERT INTO weekly_reports (id, user_id, week_start, week_end, iso_year, iso_week)
      VALUES ($1, $2, $3::date, $3::date + 6, 2026, 41)`;
    await assert.rejects(e.db.query(insertWeek, [uuid(), user, '2026-10-06']), 'Wochenstart ohne Montag akzeptiert');
    await e.db.query(insertWeek, [uuid(), user, '2026-10-05']);
    await assert.rejects(e.db.query(insertWeek, [uuid(), user, '2026-10-05']), 'zweiter aktiver Wochenbericht akzeptiert');

    const seq = async (text: string) => (await e.db.query<{ change_seq: number }>(
      "INSERT INTO daily_reports (id, user_id, report_date, text) VALUES ($1, $2, '2026-10-05', $3) RETURNING change_seq",
      [uuid(), user, text])).rows[0].change_seq;
    const a = await seq('a');
    const b = await seq('b');
    assert.ok(a > 0 && b > a, `Änderungsnummern nicht monoton: ${a}, ${b}`);

    await e.db.query('DELETE FROM users WHERE id = $1', [user]);
    const remaining = await e.db.query('SELECT (SELECT count(*) FROM daily_reports) + (SELECT count(*) FROM weekly_reports) AS n');
    assert.equal(remaining.rows[0].n, 0, 'Kaskade beim Löschen eines Kontos fehlgeschlagen');

    // Erneutes Migrieren ist ein No-op; die Schema-Version bleibt aktuell.
    assert.equal(await migrate(e.db, silentLogger()), 0);
    assert.equal(await schemaVersion(e.db), latestSchemaVersion());
  });

  test('kontrollierter Shutdown: laufende Anfragen werden beendet, neue abgewiesen', async () => {
    const e = await newEnv();
    const tok = (await e.register()).access;
    // Langsame Anfrage: Argon2-Prüfung bei einer Passwortänderung.
    const inflight = e.post('/api/v1/account/password', tok, { currentPassword: 'falsch-falsch-123', newPassword: 'neu-neu-neu-neu-1' });
    await new Promise((r) => setTimeout(r, 20));
    const closing = e.server.close(5000);
    const late = await e.get('/api/v1/health/live').catch(() => null);
    assert.ok(late === null || late.status === 503, `neue Anfrage während des Shutdowns: ${late?.status}`);
    assert.equal((await inflight).status, 401); // vollständig beantwortet
    assert.equal(await closing, true);
  });
});
