// Benutzer A darf niemals Daten von Benutzer B sehen oder verändern – und umgekehrt (IDOR-Schutz).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { needsDb, newEnv, push, statuses } from '../helpers.ts';

describe('Datentrennung zwischen Benutzern', needsDb, () => {
  test('Benutzer B kann Daten von A weder lesen noch ändern', async () => {
    const e = await newEnv();
    const a = await e.register('a@example.org');
    const b = await e.register('b@example.org');

    const dailyId = (await e.post('/api/v1/daily-reports', a.access, { date: '2026-10-05', text: 'Geheimer Bericht von A' })).expect(201).data.id;
    const weeklyId = (await e.post('/api/v1/weekly-reports', a.access, { weekStart: '2026-10-05', content: 'Wochenbericht von A' })).expect(201).data.id;

    // Lesen
    (await e.get(`/api/v1/daily-reports/${dailyId}`, b.access)).expect(404);
    (await e.get(`/api/v1/weekly-reports/${weeklyId}`, b.access)).expect(404);
    for (const path of ['/api/v1/daily-reports', '/api/v1/weekly-reports', '/api/v1/weeks/2026-10-05', '/api/v1/sync/changes?cursor=0']) {
      const raw = (await e.get(path, b.access)).expect(200).raw;
      assert.ok(!raw.includes('von A') && !raw.includes(dailyId) && !raw.includes(a.userId), `${path} enthält fremde Daten: ${raw}`);
    }

    // Ändern und Löschen
    (await e.put(`/api/v1/daily-reports/${dailyId}`, b.access, { version: 1, date: '2026-10-05', text: 'Von B' })).expect(404);
    (await e.put(`/api/v1/weekly-reports/${weeklyId}`, b.access, { version: 1, weekStart: '2026-10-05', content: 'Von B' })).expect(404);
    (await e.delete(`/api/v1/daily-reports/${dailyId}?version=1`, b.access)).expect(404);
    (await e.delete(`/api/v1/weekly-reports/${weeklyId}?version=1`, b.access)).expect(404);

    // Erstellen mit der ID eines fremden Berichts verrät dessen Inhalt nicht.
    const hijack = (await e.post('/api/v1/daily-reports', b.access, { id: dailyId, date: '2026-10-05', text: 'B' })).expect(409);
    assert.equal(hijack.body.error.conflict.reason, 'ID_UNAVAILABLE');
    assert.equal(hijack.body.error.conflict.serverRecord, null);
    assert.ok(!hijack.raw.includes('Geheimer'));

    // Sync: Push auf fremde IDs wird abgelehnt – auch mit einer userId im Body.
    const r = (await e.post('/api/v1/sync/push', b.access, push(
      { type: 'DAILY_REPORT', operation: 'UPSERT', id: dailyId, baseVersion: 1, userId: a.userId, data: { date: '2026-10-05', text: 'B' } },
      { type: 'DAILY_REPORT', operation: 'DELETE', id: dailyId, baseVersion: 1 },
      { type: 'PROFILE', operation: 'UPSERT', id: a.userId, baseVersion: 1, data: { name: 'Gekapert' } },
    ))).expect(200);
    assert.deepEqual(statuses(r), ['REJECTED', 'REJECTED', 'REJECTED']);

    // Eine userId im Body wird ignoriert – maßgeblich ist nur das Token.
    const own = (await e.post('/api/v1/daily-reports', b.access, { userId: a.userId, date: '2026-10-06', text: 'B eigen' })).expect(201);
    (await e.get(`/api/v1/daily-reports/${own.data.id}`, a.access)).expect(404);
    (await e.get(`/api/v1/daily-reports/${own.data.id}`, b.access)).expect(200);

    // A sieht seine Daten unverändert.
    assert.equal((await e.get(`/api/v1/daily-reports/${dailyId}`, a.access)).data.text, 'Geheimer Bericht von A');
    assert.equal((await e.get('/api/v1/profile', a.access)).data.name, '');
  });

  test('Profil und Geräte nur für den eigenen Benutzer', async () => {
    const e = await newEnv();
    const device = '11111111-1111-4111-8111-111111111111';
    const a = await e.register('', { device: { id: device, name: 'Pixel A' } });
    const b = await e.register();
    (await e.put('/api/v1/profile', a.access, { version: 1, name: 'Anna A' })).expect(200);
    assert.equal((await e.get('/api/v1/profile', b.access)).data.name, '');
    assert.equal((await e.get('/api/v1/devices', b.access)).data.length, 0);
    (await e.delete(`/api/v1/devices/${device}`, b.access)).expect(404);
    (await e.get(`/api/v1/devices/${device}`, b.access)).expect(404);
    (await e.patch(`/api/v1/devices/${device}`, b.access, { name: 'gekapert' })).expect(404);
    const devs = (await e.get('/api/v1/devices', a.access)).expect(200);
    assert.equal(devs.data[0].id, device);
    assert.equal(devs.data[0].current, true);
    // Gerät abmelden beendet dessen Sitzungen.
    (await e.delete(`/api/v1/devices/${device}`, a.access)).expect(204);
    (await e.get('/api/v1/profile', a.access)).expect(401);
  });

  test('Profil aktualisieren mit Versionsprüfung', async () => {
    const e = await newEnv();
    const s = await e.register();
    const p = (await e.get('/api/v1/profile', s.access)).expect(200);
    assert.equal(p.data.id, s.userId);
    assert.equal(p.data.name, '');
    assert.equal(p.data.trainingStart, null);
    assert.equal(p.data.writingStyle, 'NEUTRAL');
    assert.equal(p.data.version, 1);
    const body = {
      version: 1, name: '  Max Muster ', profession: 'Fachinformatiker für Anwendungsentwicklung', company: 'Muster GmbH',
      department: 'IT', trainerName: 'Erika Beispiel', trainingStart: '2025-08-01', trainingEnd: '2028-07-31', writingStyle: 'FORMAL',
    };
    const u = (await e.put('/api/v1/profile', s.access, body)).expect(200);
    assert.equal(u.data.name, 'Max Muster');
    assert.equal(u.data.version, 2);
    assert.equal(u.data.trainingEnd, '2028-07-31');
    assert.equal((await e.put('/api/v1/profile', s.access, body)).data.version, 2, 'identische Wiederholung erzeugt neue Version');
    const stale = (await e.put('/api/v1/profile', s.access, { version: 1, name: 'Anders' })).expect(409);
    assert.equal(stale.body.error.conflict.serverRecord.name, 'Max Muster');
    for (const bad of [
      { name: 'x' },
      { version: 1, name: 'Zeile1\nZeile2' },
      { version: 1, company: 'a'.repeat(161) },
      { version: 1, trainingStart: '2026-08-01', trainingEnd: '2025-08-01' },
      { version: 1, trainingStart: 'irgendwann' },
      { version: 1, writingStyle: 'LOCKER' },
    ]) {
      (await e.put('/api/v1/profile', s.access, bad)).expect(422);
    }
  });
});
