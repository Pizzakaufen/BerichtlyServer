import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { Device, op } from '../device-sim.ts';
import { daily, needsDb, newEnv, uuid } from '../helpers.ts';

describe('Zeitzonen, Kalenderwochen, IDOR und Wartung', needsDb, () => {
  // Sommer-/Winterzeit, Jahres- und Wochenwechsel in Europe/Berlin.
  test('aktuelle Woche um den Sommer- und Winterzeitwechsel', async () => {
    const e = await newEnv();
    const s = await e.register('', { timezone: 'Europe/Berlin' });
    const ny = await e.register('', { timezone: 'America/New_York' });
    const cases: [string, string, string][] = [
      // Umstellung auf Sommerzeit: So 29.03.2026, 02:00 → 03:00. 22:30 UTC am Sonntag = Mo 00:30 MESZ.
      ['2026-03-29T22:30:00Z', '2026-03-30', '2026-03-30'],
      ['2026-03-29T21:59:00Z', '2026-03-23', '2026-03-29'], // So 23:59 MESZ
      // Umstellung auf Winterzeit: So 25.10.2026, 03:00 → 02:00. 23:00 UTC am Sonntag = Mo 00:00 MEZ.
      ['2026-10-25T23:00:00Z', '2026-10-26', '2026-10-26'],
      ['2026-10-25T22:59:59Z', '2026-10-19', '2026-10-25'],
      // Jahreswechsel: Silvester 23:30 UTC = Neujahr 00:30 MEZ; Do 01.01.2026 liegt in KW 1 ab 29.12.2025.
      ['2025-12-31T23:30:00Z', '2025-12-29', '2026-01-01'],
    ];
    for (const [utc, week, today] of cases) {
      e.app.reports.now = () => new Date(utc);
      const w = (await e.get('/api/v1/weeks/current', s.access)).expect(200);
      assert.equal(w.data.weekStart, week, utc);
      assert.equal(w.data.today, today, utc);
    }
    // Dieselbe Uhrzeit liegt in New York noch am Sonntag der Vorwoche.
    e.app.reports.now = () => new Date('2026-03-29T22:30:00Z');
    assert.equal((await e.get('/api/v1/weeks/current', ny.access)).data.weekStart, '2026-03-23');
  });

  test('Woche nach ISO-Nummer und Filter nach Monat, Jahr und Woche', async () => {
    const e = await newEnv();
    const tok = (await e.register()).access;
    for (const d of ['2025-12-31', '2026-01-01', '2026-01-04', '2026-01-05', '2026-02-28', '2026-03-01']) {
      (await e.post('/api/v1/daily-reports', tok, daily(d, `T ${d}`))).expect(201);
    }
    const w = (await e.get('/api/v1/weeks/2026/1', tok)).expect(200);
    assert.equal(w.data.weekStart, '2025-12-29');
    assert.equal(w.data.weekEnd, '2026-01-04');
    // 2026 beginnt an einem Donnerstag und hat daher 53 ISO-Wochen, 2025 nur 52.
    assert.equal((await e.get('/api/v1/weeks/2026/53', tok)).expect(200).data.weekStart, '2026-12-28');
    (await e.get('/api/v1/weeks/2025/53', tok)).expect(400);
    (await e.get('/api/v1/weeks/2026/0', tok)).expect(400);
    (await e.get('/api/v1/weeks/abc/1', tok)).expect(400);
    (await e.get('/api/v1/weeks/2020/53', tok)).expect(200); // 2020 hatte 53 ISO-Wochen

    const check = async (q: string, ...want: string[]) =>
      assert.deepEqual((await e.get(`/api/v1/daily-reports?sort=date_asc&${q}`, tok)).expect(200).data.map((x: { text: string }) => x.text), want, q);
    await check('isoYear=2026&isoWeek=1', 'T 2025-12-31', 'T 2026-01-01', 'T 2026-01-04');
    await check('year=2026&month=2', 'T 2026-02-28');
    await check('year=2025', 'T 2025-12-31');
    await check('year=2026&isoYear=2026&isoWeek=1', 'T 2026-01-01', 'T 2026-01-04'); // Schnittmenge
    await check('year=2026&month=3&from=2026-03-02'); // leere Schnittmenge
    for (const bad of ['month=2', 'year=1999', 'year=2026&month=13', 'isoYear=2026', 'isoYear=2026&isoWeek=60']) {
      (await e.get(`/api/v1/daily-reports?${bad}`, tok)).expect(400);
    }
  });

  // IDOR-Szenarien: manipulierte Benutzer-, Bericht- und Geräte-IDs dürfen nie zu fremden Daten führen.
  test('manipulierte IDs und Serverfelder werden ignoriert', async () => {
    const e = await newEnv();
    const a = await e.register();
    const b = await e.register();

    // Vom Client gesendete userId/version/createdAt usw. werden ignoriert bzw. servergeneriert.
    const r = (await e.post('/api/v1/daily-reports', b.access, {
      date: '2026-10-05', text: 'B schreibt', userId: a.userId, user_id: a.userId, version: 99,
      createdAt: '2000-01-01T00:00:00.000Z', updatedAt: '2000-01-01T00:00:00.000Z', deleted: true, changeSeq: 1,
      createdByDeviceId: uuid(),
    })).expect(201);
    assert.equal(r.data.version, 1);
    assert.ok(!r.data.createdAt.startsWith('2000'));
    assert.equal(r.data.deleted, false);
    assert.equal(r.data.createdByDeviceId, null);
    assert.equal((await e.get('/api/v1/daily-reports', a.access)).body.meta.total, 0, 'Bericht landete bei fremdem Benutzer');
    (await e.put('/api/v1/profile', b.access, { version: 1, name: 'B', userId: a.userId, id: a.userId })).expect(200);
    assert.equal((await e.get('/api/v1/profile', a.access)).data.name, '');
    // Sync mit fremder Profil-ID wird abgelehnt.
    const res = (await e.post('/api/v1/sync', b.access, { changes: [{
      operationId: uuid(), type: 'PROFILE', operation: 'UPSERT', id: a.userId, baseVersion: 1, data: { name: 'Gekapert' },
    }] })).expect(200);
    assert.equal(res.data.push.results[0].status, 'REJECTED');
  });

  test('Readiness und Sicherheits-Header (HSTS nur hinter HTTPS-Proxy)', async () => {
    const e = await newEnv();
    const r = (await e.get('/api/v1/health/ready')).expect(200);
    assert.equal(r.data.status, 'ready');
    assert.equal(r.data.components.schema, 'current');
    assert.match(r.headers.get('content-security-policy') ?? '', /default-src 'none'/);
    assert.equal(r.headers.get('strict-transport-security'), null, 'HSTS ohne HTTPS-Proxy gesetzt');
    // Ohne TRUST_PROXY wird X-Forwarded-Proto ignoriert.
    assert.equal((await e.get('/api/v1/health', '', { 'X-Forwarded-Proto': 'https' })).headers.get('strict-transport-security'), null);

    const p = await newEnv({ overrides: { TRUST_PROXY: 'true' } });
    assert.ok((await p.get('/api/v1/health', '', { 'X-Forwarded-Proto': 'https' })).headers.get('strict-transport-security'));
    assert.equal((await p.get('/api/v1/health', '', { 'X-Forwarded-Proto': 'http' })).headers.get('strict-transport-security'), null);
  });

  test('Wartung beachtet Aufbewahrungsfristen', async () => {
    const e = await newEnv();
    const d = await Device.create(e, 'wartung@example.org', true);
    const recent = uuid();
    const old = uuid();
    await d.sync(op(uuid(), recent, null, 'UPSERT', 'a'), op(uuid(), old, null, 'UPSERT', 'b'));
    await d.sync(op(uuid(), recent, 1, 'DELETE', ''), op(uuid(), old, 1, 'DELETE', ''));
    await e.ageRow('daily_reports', 'deleted_at', '364 days', recent);
    await e.ageRow('daily_reports', 'deleted_at', '366 days', old);
    await e.db.query("UPDATE sync_operations SET created_at = now() - interval '31 days' WHERE entity_id = $1", [old]);
    await e.db.query("UPDATE security_events SET created_at = now() - interval '181 days' WHERE id = (SELECT min(id) FROM security_events)");

    const res = await e.app.runMaintenance();
    assert.equal(res.tombstonesPurged, 1);
    assert.equal(res.operationsPurged, 2);
    assert.equal(res.securityEventsPurged, 1);
    assert.equal((await e.db.query('SELECT count(*) AS n FROM daily_reports WHERE id = $1', [recent])).rows[0].n, 1,
      'Tombstone innerhalb der Frist gelöscht');
    // Aktive Berichte werden nie von der Wartung angetastet.
    const keep = uuid();
    await d.sync(op(uuid(), keep, null, 'UPSERT', 'aktiv'));
    await e.ageRow('daily_reports', 'created_at', '10 years', keep);
    await e.app.runMaintenance();
    (await e.get(`/api/v1/daily-reports/${keep}`, d.s.access)).expect(200);
  });
});
