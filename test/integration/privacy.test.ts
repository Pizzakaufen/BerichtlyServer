// Server 2.1: Datenauskunft, Kontolöschung, Rechtsseiten und barrierearme Anmeldeseite des Dashboards.
//
// HINWEIS: geschrieben, aber in der Entwicklungsumgebung nicht ausgeführt (kein Node.js/PostgreSQL verfügbar).
// Ausführen: BERICHTLY_TEST_DATABASE_URL=… npm run test:integration

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { setRoleByEmail } from '../../src/db/repositories/admin.ts';
import { DEFAULT_PASSWORD, needsDb, newEnv } from '../helpers.ts';

describe('Datenschutzfunktionen', needsDb, () => {
  test('Export enthält die eigenen Daten – ohne Passwort-Hash, Tokens oder fremde Daten', async () => {
    const e = await newEnv();
    const a = await e.register('export-a@example.org');
    const b = await e.register('export-b@example.org');
    (await e.post('/api/v1/daily-reports', a.access, { date: '2026-10-05', text: 'Bericht von A' })).expect(201);
    (await e.post('/api/v1/daily-reports', b.access, { date: '2026-10-05', text: 'Bericht von B' })).expect(201);
    (await e.get('/api/v1/account/export', '')).expect(401);
    const r = (await e.get('/api/v1/account/export', a.access)).expect(200);
    assert.equal(r.data.format, 'berichtly-account-export');
    assert.equal(r.data.account.email, 'export-a@example.org');
    assert.equal(r.data.dailyReports.length, 1);
    assert.equal(r.data.dailyReports[0].text, 'Bericht von A');
    assert.ok(!r.raw.includes('Bericht von B'));
    assert.ok(!/password_hash|passwordHash|token_hash|\$argon2|\$scrypt/.test(r.raw), 'Export enthält Geheimnisse');
    assert.ok(!r.raw.includes(a.access) && !r.raw.includes(a.refresh));
  });

  test('Kontolöschung verlangt Passwort und Bestätigung und entfernt alle Daten', async () => {
    const e = await newEnv();
    const a = await e.register('delete@example.org');
    (await e.post('/api/v1/daily-reports', a.access, { date: '2026-10-05', text: 'wird gelöscht' })).expect(201);
    (await e.request('DELETE', '/api/v1/account', a.access, { password: DEFAULT_PASSWORD })).expect(422);
    (await e.request('DELETE', '/api/v1/account', a.access, { password: 'falsch-falsch-falsch', confirm: 'DELETE' })).expect(401);
    (await e.request('DELETE', '/api/v1/account', '', { password: DEFAULT_PASSWORD, confirm: 'DELETE' })).expect(401);
    (await e.request('DELETE', '/api/v1/account', a.access, { password: DEFAULT_PASSWORD, confirm: 'DELETE' })).expect(204);
    for (const table of ['users', 'daily_reports', 'user_profiles', 'devices', 'sessions', 'security_events']) {
      const col = table === 'users' ? 'id' : 'user_id';
      const n = (await e.db.pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${col} = $1`, [a.userId])).rows[0].n;
      assert.equal(n, 0, `${table} enthält noch Daten`);
    }
    // Alte Tokens sind wertlos, eine Anmeldung ist nicht mehr möglich.
    (await e.get('/api/v1/account', a.access)).expect(401);
    (await e.post('/api/v1/auth/login', '', { email: 'delete@example.org', password: DEFAULT_PASSWORD })).expect(401);
  });

  test('Administratorkonten lassen sich nicht über die API löschen', async () => {
    const e = await newEnv();
    const a = await e.register('admin-del@example.org');
    assert.ok(await setRoleByEmail(e.db.pool, 'admin-del@example.org', 'admin'));
    (await e.request('DELETE', '/api/v1/account', a.access, { password: DEFAULT_PASSWORD, confirm: 'DELETE' })).expect(409);
  });

  test('Rechtsseiten nur, wenn der Betreiber sie hinterlegt hat', async () => {
    const off = await newEnv();
    assert.deepEqual((await off.get('/api/v1/legal', '')).expect(200).data, { imprintUrl: null, privacyUrl: null });
    assert.equal((await fetch(`${off.base}/legal/impressum`)).status, 404);

    const dir = mkdtempSync(join(tmpdir(), 'berichtly-legal-'));
    writeFileSync(join(dir, 'privacy.txt'), '# Verantwortlicher\n\nTest <i>Betreiber</i>');
    const on = await newEnv({ overrides: { LEGAL_PRIVACY_FILE: join(dir, 'privacy.txt') } });
    assert.deepEqual((await on.get('/api/v1/legal', '')).expect(200).data, { imprintUrl: null, privacyUrl: '/legal/datenschutz' });
    const page = await fetch(`${on.base}/legal/datenschutz`);
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.match(html, /<html lang="de">/);
    assert.match(html, /<h2>Verantwortlicher<\/h2>/);
    assert.ok(html.includes('&lt;i&gt;Betreiber&lt;/i&gt;'));
    assert.ok(!html.includes('<script'));
  });

  test('Anmeldeseite des Dashboards: Beschriftungen, Pflichtfelder, verknüpfte Fehlermeldung', async () => {
    const e = await newEnv({ overrides: { ADMIN_DASHBOARD_ENABLED: 'true', ADMIN_COOKIE_SECURE: 'false', RATE_LIMIT_ADMIN_LOGIN_PER_MINUTE: '100' } });
    const page = await (await fetch(`${e.base}/admin/login`)).text();
    assert.match(page, /<label for="email">/);
    assert.match(page, /<label for="password">/);
    assert.match(page, /href="#main"/);
    assert.match(page, /<main id="main"/);
    const failed = await (await fetch(`${e.base}/admin/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: 'x@example.org', password: 'falsch' }).toString(),
    })).text();
    assert.match(failed, /id="login-error" role="alert"/);
    assert.match(failed, /aria-describedby="login-error"/);
  });
});
