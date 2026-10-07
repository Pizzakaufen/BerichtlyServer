import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { DEFAULT_PASSWORD, type Env, needsDb, newEnv, uuid } from '../helpers.ts';

const loginDevice = async (e: Env, email: string, deviceId: string, name: string) =>
  (await e.post('/api/v1/auth/login', '', {
    email, password: DEFAULT_PASSWORD,
    device: { id: deviceId, name, platform: 'android', osVersion: '15', appVersion: '2.2.0' },
  })).expect(200).session();

describe('Geräte, Sitzungen und Sicherheitsereignisse', needsDb, () => {
  test('mehrere Geräte pro Konto verwalten', async () => {
    const e = await newEnv();
    const email = 'geraete@example.org';
    const phone = uuid();
    const tablet = uuid();
    await e.register(email);
    const s1 = await loginDevice(e, email, phone, 'Pixel 9');
    const s2 = await loginDevice(e, email, tablet, 'Galaxy Tab');

    const list = (await e.get('/api/v1/devices', s1.access)).expect(200);
    assert.equal(list.body.meta.total, 2);
    assert.equal(list.data.length, 2);
    const d = (await e.get(`/api/v1/devices/${phone}`, s1.access)).expect(200).data;
    assert.equal(d.name, 'Pixel 9');
    assert.equal(d.platform, 'ANDROID');
    assert.equal(d.osVersion, '15');
    assert.equal(d.appVersion, '2.2.0');
    assert.equal(d.syncStatus, 'NEVER');
    assert.equal(d.current, true);
    assert.equal(d.lastSyncAt, null);

    // Anzeigename und App-Version aktualisieren; nicht gesendete Felder bleiben.
    const u = (await e.patch(`/api/v1/devices/${phone}`, s1.access, { name: 'Mein Handy', appVersion: '2.2.1' })).expect(200).data;
    assert.equal(u.name, 'Mein Handy');
    assert.equal(u.appVersion, '2.2.1');
    assert.equal(u.osVersion, '15');
    (await e.patch(`/api/v1/devices/${phone}`, s1.access, { name: 'x'.repeat(101) })).expect(422);
    (await e.patch(`/api/v1/devices/${phone}`, s1.access, { name: 'Zeile\nUmbruch' })).expect(422);

    // Tablet abmelden: dessen Sitzung ist sofort ungültig, das Gerät verschwindet aus der Liste.
    (await e.delete(`/api/v1/devices/${tablet}`, s1.access)).expect(204);
    (await e.get('/api/v1/profile', s2.access)).expect(401);
    (await e.post('/api/v1/auth/refresh', '', { refreshToken: s2.refresh })).expect(401);
    assert.equal((await e.get('/api/v1/devices', s1.access)).body.meta.total, 1);
    assert.equal((await e.get('/api/v1/devices?includeRevoked=true', s1.access)).body.meta.total, 2);
    (await e.delete(`/api/v1/devices/${tablet}`, s1.access)).expect(404); // bereits abgemeldet
    (await e.patch(`/api/v1/devices/${tablet}`, s1.access, { name: 'x' })).expect(404);

    // Erneute Anmeldung reaktiviert dasselbe Gerät (gleiche stabile ID, kein Duplikat).
    await loginDevice(e, email, tablet, 'Galaxy Tab');
    assert.equal((await e.get('/api/v1/devices?includeRevoked=true', s1.access)).body.meta.total, 2);
    (await e.get('/api/v1/devices?limit=1&page=2', s1.access)).expect(200);
    (await e.get('/api/v1/devices?includeRevoked=vielleicht', s1.access)).expect(400);
  });

  test('Gerät nachträglich registrieren', async () => {
    const e = await newEnv();
    const s = await e.register(); // Login ohne Geräteangabe
    assert.equal((await e.post('/api/v1/sync/complete', s.access, { result: 'SUCCESS', cursor: '0' })).expect(409).code, 'DEVICE_REQUIRED');

    const id = uuid();
    const r = (await e.post('/api/v1/devices', s.access, { id, name: 'Pixel', osVersion: '14', appVersion: '2.2.0' })).expect(201);
    assert.equal(r.data.id, id);
    assert.equal(r.data.current, true);
    // Erneutes Registrieren ist idempotent.
    (await e.post('/api/v1/devices', s.access, { id, name: 'Pixel' })).expect(200);
    // Die Sitzung ist jetzt an das Gerät gebunden: Sync-Status ist gerätebezogen.
    assert.equal((await e.get('/api/v1/sync/status', s.access)).data.device.deviceId, id);
    (await e.post('/api/v1/devices', s.access, { name: 'ohne ID' })).expect(422);
    (await e.post('/api/v1/devices', s.access, { id: 'keine-uuid' })).expect(422);
  });

  test('Geräte und Sitzungen anderer Benutzer sind unerreichbar', async () => {
    const e = await newEnv();
    const deviceA = uuid();
    const a = await e.register('', { device: { id: deviceA, name: 'Gerät A' } });
    const b = await e.register();

    (await e.get(`/api/v1/devices/${deviceA}`, b.access)).expect(404);
    (await e.patch(`/api/v1/devices/${deviceA}`, b.access, { name: 'gekapert' })).expect(404);
    (await e.delete(`/api/v1/devices/${deviceA}`, b.access)).expect(404);
    (await e.delete(`/api/v1/sessions/${a.sessionId}`, b.access)).expect(404);
    // B registriert ein Gerät mit derselben Geräte-ID: eigenes Gerät, As Gerät bleibt unberührt.
    (await e.post('/api/v1/devices', b.access, { id: deviceA, name: 'Bs Gerät' })).expect(201);
    assert.equal((await e.get(`/api/v1/devices/${deviceA}`, a.access)).data.name, 'Gerät A');
    (await e.get('/api/v1/profile', a.access)).expect(200);
    for (const path of ['/api/v1/sessions', '/api/v1/account/security-events', '/api/v1/devices']) {
      assert.ok(!(await e.get(path, b.access)).expect(200).raw.includes(a.sessionId), `${path} enthält Daten von A`);
    }
  });

  test('Sitzungen auflisten und beenden', async () => {
    const e = await newEnv();
    const email = 'sitzungen@example.org';
    const s1 = await e.register(email);
    const s2 = await loginDevice(e, email, uuid(), 'Zweitgerät');

    const list = (await e.get('/api/v1/sessions', s1.access)).expect(200);
    assert.equal(list.body.meta.total, 2);
    const current = list.data.filter((s: { current: boolean }) => s.current);
    assert.equal(current.length, 1);
    assert.equal(current[0].id, s1.sessionId);
    (await e.delete(`/api/v1/sessions/${s2.sessionId}`, s1.access)).expect(204);
    (await e.get('/api/v1/profile', s2.access)).expect(401);
    (await e.delete(`/api/v1/sessions/${uuid()}`, s1.access)).expect(404);
    (await e.delete('/api/v1/sessions/kaputt', s1.access)).expect(400);
  });

  test('alle Sitzungen abmelden', async () => {
    const e = await newEnv();
    const email = 'alle@example.org';
    const s1 = await e.register(email);
    const s2 = await loginDevice(e, email, uuid(), 'Tablet');
    assert.equal((await e.post('/api/v1/auth/logout-all', s1.access)).expect(200).data.revokedSessions, 2);
    for (const s of [s1, s2]) {
      (await e.get('/api/v1/profile', s.access)).expect(401);
      (await e.post('/api/v1/auth/refresh', '', { refreshToken: s.refresh })).expect(401);
    }
  });

  test('Passwort ändern widerruft andere Sitzungen', async () => {
    const e = await newEnv();
    const email = 'pw@example.org';
    const s1 = await e.register(email);
    const s2 = await loginDevice(e, email, uuid(), 'Anderes Gerät');
    const newPw = 'neues-Passwort-2026!';

    (await e.post('/api/v1/account/password', s1.access, { currentPassword: 'falsch-falsch', newPassword: newPw })).expect(401);
    (await e.post('/api/v1/account/password', s1.access, { currentPassword: DEFAULT_PASSWORD, newPassword: 'kurz' })).expect(422);
    (await e.post('/api/v1/account/password', s1.access, { currentPassword: DEFAULT_PASSWORD, newPassword: DEFAULT_PASSWORD })).expect(422);
    (await e.post('/api/v1/account/password', s1.access, { currentPassword: DEFAULT_PASSWORD, newPassword: newPw })).expect(204);

    (await e.get('/api/v1/profile', s1.access)).expect(200); // aktuelle Sitzung bleibt
    (await e.get('/api/v1/profile', s2.access)).expect(401); // andere Sitzungen widerrufen
    (await e.login(email, DEFAULT_PASSWORD)).expect(401);
    (await e.login(email, newPw)).expect(200);

    const { rows } = await e.db.query('SELECT password_hash FROM users WHERE email = $1', [email]);
    assert.ok(rows[0].password_hash.startsWith('$argon2id$') && !rows[0].password_hash.includes(newPw));
  });

  test('Sicherheitsereignisse ohne sensible Daten', async () => {
    const e = await newEnv();
    const email = 'audit@example.org';
    const s = await e.register(email);
    (await e.login(email, 'falsches-Passwort-1')).expect(401);
    (await e.login('unbekannt@example.org', 'egal-egal-egal')).expect(401);
    const dev = uuid();
    await loginDevice(e, email, dev, 'Handy');
    (await e.delete(`/api/v1/devices/${dev}`, s.access)).expect(204);
    (await e.post('/api/v1/auth/refresh', '', { refreshToken: s.refresh })).expect(200);
    (await e.post('/api/v1/auth/refresh', '', { refreshToken: s.refresh })).expect(401); // Wiederverwendung

    // Nach der Wiederverwendung ist die ursprüngliche Sitzung widerrufen – neu anmelden.
    const fresh = (await e.login(email, DEFAULT_PASSWORD)).expect(200).session();
    const ev = (await e.get('/api/v1/account/security-events?limit=100', fresh.access)).expect(200);
    const types: string[] = ev.data.map((x: { type: string }) => x.type);
    for (const want of ['REGISTERED', 'LOGIN_FAILED', 'LOGIN_SUCCEEDED', 'DEVICE_REVOKED', 'REFRESH_TOKEN_REUSE']) {
      assert.ok(types.includes(want), `Ereignis ${want} fehlt: ${types}`);
    }
    assert.ok(!types.includes('LOGIN_FAILED_UNKNOWN_ACCOUNT'), 'Ereignis eines unbekannten Kontos sichtbar');
    // In der Tabelle stehen weder E-Mail-Adressen noch Passwörter oder Tokens.
    const leaked = await e.db.query(`SELECT count(*) AS n FROM security_events e
      WHERE row_to_json(e)::text ILIKE '%example.org%' OR row_to_json(e)::text LIKE '%brt_%'
         OR row_to_json(e)::text LIKE '%falsches-Passwort%'`);
    assert.equal(leaked.rows[0].n, 0);
    const unknown = await e.db.query(`SELECT count(*) AS n FROM security_events
      WHERE event_type = 'LOGIN_FAILED_UNKNOWN_ACCOUNT' AND user_id IS NULL`);
    assert.equal(unknown.rows[0].n, 1);
  });

  test('Login-Limit pro Konto', async () => {
    const e = await newEnv({ overrides: { RATE_LIMIT_LOGIN_PER_ACCOUNT_PER_MINUTE: '3' } });
    await e.register('ziel@example.org');
    for (let i = 0; i < 3; i++) (await e.login('ziel@example.org', 'falsch-falsch-123')).expect(401);
    const r = (await e.login(' ZIEL@example.org', DEFAULT_PASSWORD)).expect(429); // gleiche Adresse, andere Schreibweise
    assert.equal(r.code, 'RATE_LIMITED');
    assert.ok(r.headers.get('retry-after'));
    await e.register('anderes@example.org');
    (await e.login('anderes@example.org', DEFAULT_PASSWORD)).expect(200); // andere Konten unberührt
  });

  test('Refresh hat ein eigenes, größeres Limit', async () => {
    const e = await newEnv({ overrides: {
      RATE_LIMIT_AUTH_PER_MINUTE: '', RATE_LIMIT_LOGIN_PER_MINUTE: '2', RATE_LIMIT_REGISTER_PER_MINUTE: '1',
      RATE_LIMIT_REFRESH_PER_MINUTE: '5',
    } });
    const s = await e.register();
    (await e.post('/api/v1/auth/register', '', { email: 'zwei@example.org', password: DEFAULT_PASSWORD })).expect(429);
    // Refresh ist vom Login-/Registrierungslimit unabhängig.
    let tok = s.refresh;
    for (let i = 0; i < 5; i++) tok = (await e.post('/api/v1/auth/refresh', '', { refreshToken: tok })).expect(200).session().refresh;
    (await e.post('/api/v1/auth/refresh', '', { refreshToken: tok })).expect(429);
  });
});
