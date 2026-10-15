// Admin-Dashboard (Server 2.0): Zugriffsschutz, Berechtigungen, CSRF, Bestätigung, Audit und Datensparsamkeit.
//
// HINWEIS: Diese Tests wurden geschrieben, aber in der Entwicklungsumgebung von Server 2.0 nicht ausgeführt
// (kein Node.js/PostgreSQL verfügbar). Ausführen: BERICHTLY_TEST_DATABASE_URL=… npm run test:integration

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { setRoleByEmail } from '../../src/db/repositories/admin.ts';
import { DEFAULT_PASSWORD, type Env, needsDb, newEnv } from '../helpers.ts';

const ADMIN = { ADMIN_DASHBOARD_ENABLED: 'true', ADMIN_COOKIE_SECURE: 'false', RATE_LIMIT_ADMIN_LOGIN_PER_MINUTE: '100' };

interface Page { status: number; headers: Headers; text: string }

async function call(e: Env, method: string, path: string, opts: { cookie?: string; form?: Record<string, string>; headers?: Record<string, string> } = {}): Promise<Page> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.cookie) headers.Cookie = opts.cookie;
  let body: string | undefined;
  if (opts.form) {
    body = new URLSearchParams(opts.form).toString();
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
  }
  const res = await fetch(e.base + path, { method, headers, body, redirect: 'manual' });
  return { status: res.status, headers: res.headers, text: await res.text() };
}

async function adminSession(e: Env, email: string): Promise<{ cookie: string; csrf: string }> {
  await e.register(email);
  assert.ok(await setRoleByEmail(e.db.pool, email, 'admin'));
  const r = await call(e, 'POST', '/admin/login', { form: { email, password: DEFAULT_PASSWORD } });
  assert.equal(r.status, 303);
  const setCookie = r.headers.get('set-cookie') ?? '';
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  const cookie = setCookie.split(';')[0];
  const home = await call(e, 'GET', '/admin', { cookie });
  assert.equal(home.status, 200);
  const csrf = /name="csrf" value="([^"]+)"/.exec(home.text)?.[1];
  assert.ok(csrf, 'CSRF-Token fehlt');
  return { cookie, csrf };
}

describe('Admin-Dashboard', needsDb, () => {
  test('ist ohne ausdrückliche Aktivierung nicht vorhanden', async () => {
    const e = await newEnv();
    assert.equal((await call(e, 'GET', '/admin')).status, 404);
    assert.equal((await call(e, 'GET', '/admin/login')).status, 404);
    assert.equal((await call(e, 'POST', '/admin/login', { form: { email: 'x@example.org', password: 'y' } })).status, 404);
  });

  test('ohne Anmeldung nur die Anmeldeseite – mit strengen Sicherheits-Headern', async () => {
    const e = await newEnv({ overrides: ADMIN });
    for (const path of ['/admin', '/admin/users', '/admin/sync', '/admin/system', `/admin/users/${crypto.randomUUID()}`]) {
      const r = await call(e, 'GET', path);
      assert.equal(r.status, 303, path);
      assert.equal(r.headers.get('location'), '/admin/login');
    }
    const login = await call(e, 'GET', '/admin/login');
    assert.equal(login.status, 200);
    assert.match(login.headers.get('content-security-policy') ?? '', /default-src 'none'/);
    assert.match(login.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
    assert.equal(login.headers.get('cache-control'), 'no-store');
    assert.equal(login.headers.get('x-frame-options'), 'DENY');
    assert.ok(!login.text.includes('<script'), 'Dashboard enthält kein JavaScript');
    // Verändernde Anfragen ohne Anmeldung werden abgelehnt.
    assert.equal((await call(e, 'POST', `/admin/users/${crypto.randomUUID()}/disable`, { form: { confirm: 'yes' } })).status, 403);
  });

  test('normale Konten werden abgelehnt – mit gleicher Meldung wie bei falschem Passwort', async () => {
    const e = await newEnv({ overrides: ADMIN });
    await e.register('user@example.org');
    const denied = await call(e, 'POST', '/admin/login', { form: { email: 'user@example.org', password: DEFAULT_PASSWORD } });
    const wrong = await call(e, 'POST', '/admin/login', { form: { email: 'user@example.org', password: 'falsch-falsch-falsch' } });
    assert.equal(denied.status, 401);
    assert.equal(wrong.status, 401);
    assert.equal(denied.headers.get('set-cookie'), null);
    const msg = (t: string) => /role="alert">([^<]+)</.exec(t)?.[1];
    assert.equal(msg(denied.text), msg(wrong.text));
    const events = await e.db.query<{ event_type: string }>("SELECT event_type FROM security_events WHERE event_type LIKE 'ADMIN_%'");
    assert.deepEqual(events.rows.map((r) => r.event_type).sort(), ['ADMIN_LOGIN_DENIED', 'ADMIN_LOGIN_FAILED']);
  });

  test('Aktionen brauchen CSRF-Token, gleiche Herkunft und Bestätigung – und werden protokolliert', async () => {
    const e = await newEnv({ overrides: ADMIN });
    const { cookie, csrf } = await adminSession(e, 'admin@example.org');
    const target = await e.register('ziel@example.org');
    const path = `/admin/users/${target.userId}/disable`;

    assert.equal((await call(e, 'POST', path, { cookie, form: { confirm: 'yes' } })).status, 403);                 // ohne Token
    assert.equal((await call(e, 'POST', path, { cookie, form: { csrf: 'x'.repeat(43), confirm: 'yes' } })).status, 403); // falsches Token
    assert.equal((await call(e, 'POST', path, { cookie, form: { csrf, confirm: 'yes' }, headers: { Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await call(e, 'POST', path, { cookie, form: { csrf, confirm: 'yes' }, headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    assert.equal((await call(e, 'POST', path, { cookie, form: { csrf } })).status, 400);                            // ohne Bestätigung
    let status = (await e.db.query<{ status: string }>('SELECT status FROM users WHERE id = $1', [target.userId])).rows[0].status;
    assert.equal(status, 'ACTIVE');

    const ok = await call(e, 'POST', path, { cookie, form: { csrf, confirm: 'yes' } });
    assert.equal(ok.status, 303);
    status = (await e.db.query<{ status: string }>('SELECT status FROM users WHERE id = $1', [target.userId])).rows[0].status;
    assert.equal(status, 'DISABLED');
    // Gesperrtes Konto: bestehende App-Sitzung ungültig, neue Anmeldung abgelehnt.
    (await e.get('/api/v1/account', target.access)).expect(401);
    (await e.login('ziel@example.org', DEFAULT_PASSWORD)).expect(403);
    const audit = await e.db.query<{ action: string; target_user_id: string }>("SELECT action, target_user_id FROM admin_audit_log WHERE action = 'USER_DISABLED'");
    assert.equal(audit.rows.length, 1);
    assert.equal(audit.rows[0].target_user_id, target.userId);
  });

  test('zeigt keine Berichtsinhalte, Tokens oder Passwort-Hashes', async () => {
    const e = await newEnv({ overrides: ADMIN });
    const { cookie } = await adminSession(e, 'admin@example.org');
    const user = await e.register('azubi@example.org');
    (await e.post('/api/v1/daily-reports', user.access, { date: '2026-10-05', text: 'Streng vertraulicher Tagesbericht' })).expect(201);
    for (const path of ['/admin', '/admin/users', `/admin/users/${user.userId}`, '/admin/sync', '/admin/system']) {
      const r = await call(e, 'GET', path, { cookie });
      assert.equal(r.status, 200, path);
      assert.ok(!r.text.includes('vertraulicher'), `${path} zeigt Berichtsinhalt`);
      assert.ok(!r.text.includes(user.access) && !r.text.includes(user.refresh), `${path} zeigt Tokens`);
      assert.ok(!r.text.includes('$argon2') && !r.text.includes('$scrypt'), `${path} zeigt Passwort-Hashes`);
    }
  });

  test('HTML-Sonderzeichen in Daten werden maskiert', async () => {
    const e = await newEnv({ overrides: ADMIN });
    const { cookie } = await adminSession(e, 'admin@example.org');
    const r = await call(e, 'GET', '/admin/users?q=%3Cscript%3Ealert(1)%3C%2Fscript%3E', { cookie });
    assert.equal(r.status, 200);
    assert.ok(!r.text.includes('<script>alert(1)</script>'));
    assert.ok(r.text.includes('&lt;script&gt;'));
  });

  test('das eigene Konto lässt sich nicht sperren', async () => {
    const e = await newEnv({ overrides: ADMIN });
    const { cookie, csrf } = await adminSession(e, 'admin@example.org');
    const self = (await e.db.query<{ id: string }>("SELECT id FROM users WHERE email = 'admin@example.org'")).rows[0].id;
    assert.equal((await call(e, 'POST', `/admin/users/${self}/disable`, { cookie, form: { csrf, confirm: 'yes' } })).status, 400);
  });

  test('entzogene Rechte, Abmeldung und Leerlauf beenden die Sitzung', async () => {
    const e = await newEnv({ overrides: ADMIN });
    const s1 = await adminSession(e, 'admin@example.org');
    await setRoleByEmail(e.db.pool, 'admin@example.org', 'user');
    assert.equal((await call(e, 'GET', '/admin', { cookie: s1.cookie })).status, 303);

    await setRoleByEmail(e.db.pool, 'admin@example.org', 'admin');
    const login = await call(e, 'POST', '/admin/login', { form: { email: 'admin@example.org', password: DEFAULT_PASSWORD } });
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
    await e.db.query("UPDATE admin_sessions SET last_seen_at = now() - interval '2 hours'");
    assert.equal((await call(e, 'GET', '/admin', { cookie })).status, 303); // Leerlauf überschritten
    assert.equal((await call(e, 'GET', '/admin', { cookie: 'berichtly_admin=manipuliert' })).status, 303);
  });
});
