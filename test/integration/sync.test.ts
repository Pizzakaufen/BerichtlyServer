import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { dailyChange, needsDb, newEnv, push, statuses, uuid } from '../helpers.ts';

describe('Synchronisierung', needsDb, () => {
  test('vollständiger Ablauf', async () => {
    const e = await newEnv();
    const device = uuid();
    const tok = (await e.register('', { device: { id: device, name: 'Pixel Test' } })).access;

    const initial = (await e.get('/api/v1/sync/changes?cursor=0', tok)).expect(200);
    assert.equal(initial.data.changes.length, 1);
    assert.equal(initial.data.changes[0].type, 'PROFILE');
    const cursor0 = initial.data.nextCursor;

    const id = uuid();
    const res = (await e.post('/api/v1/sync/push', tok, push(dailyChange(id, 'Offline erfasst', null, 'UPSERT')))).expect(200);
    assert.equal(res.data.results[0].status, 'APPLIED');
    assert.equal(res.data.results[0].version, 1);
    // Wiederholung (z. B. Antwort verloren) ist idempotent.
    const retry = await e.post('/api/v1/sync/push', tok, push(dailyChange(id, 'Offline erfasst', null, 'UPSERT')));
    assert.equal(retry.data.results[0].status, 'APPLIED');
    assert.equal(retry.data.results[0].version, 1);

    const pull1 = await e.get(`/api/v1/sync/changes?cursor=${cursor0}`, tok);
    assert.equal(pull1.data.changes.length, 1);
    assert.equal(pull1.data.changes[0].id, id);
    assert.equal(pull1.data.changes[0].data.text, 'Offline erfasst');
    const cursor1 = pull1.data.nextCursor;

    // Änderung auf dem Server (anderes Gerät) erscheint im nächsten Pull.
    (await e.put(`/api/v1/daily-reports/${id}`, tok, { version: 1, date: '2026-10-05', text: 'Auf Gerät 2 geändert' })).expect(200);
    const pull2 = await e.get(`/api/v1/sync/changes?cursor=${cursor1}`, tok);
    assert.equal(pull2.data.changes[0].version, 2);

    // Konflikt: lokale Änderung basiert noch auf Version 1.
    const c = await e.post('/api/v1/sync/push', tok, push(dailyChange(id, 'Lokal geändert', 1, 'UPSERT')));
    assert.equal(c.data.results[0].status, 'CONFLICT');
    assert.equal(c.data.results[0].conflict.reason, 'VERSION_MISMATCH');
    assert.equal(c.data.results[0].conflict.serverRecord.text, 'Auf Gerät 2 geändert');

    // Löschen → Tombstone im Pull.
    assert.equal((await e.post('/api/v1/sync/push', tok, push(dailyChange(id, '', 2, 'DELETE')))).data.results[0].status, 'APPLIED');
    const pull3 = await e.get(`/api/v1/sync/changes?cursor=${pull2.data.nextCursor}`, tok);
    assert.equal(pull3.data.changes[0].deleted, true);
    assert.equal(pull3.data.changes[0].data, null);
    assert.equal(pull3.data.changes[0].version, 3);
    // Bearbeiten eines gelöschten Datensatzes → Konflikt statt Wiederherstellung.
    const dead = await e.post('/api/v1/sync/push', tok, push(dailyChange(id, 'Noch lokal', 2, 'UPSERT')));
    assert.equal(dead.data.results[0].conflict.reason, 'DELETED_ON_SERVER');

    const st = (await e.get('/api/v1/sync/status', tok)).expect(200);
    assert.equal(st.data.serverCursor, pull3.data.nextCursor);
    assert.equal(st.data.device.deviceId, device);
    assert.equal(st.data.device.lastPullCursor, pull3.data.nextCursor);
    assert.ok(st.data.device.lastPushAt);
  });

  test('Push verarbeitet Elemente einzeln', async () => {
    const e = await newEnv();
    const tok = (await e.register()).access;
    const good = uuid();
    const r = (await e.post('/api/v1/sync/push', tok, push(
      dailyChange(good, 'Gültig', null, 'UPSERT'),
      { type: 'DAILY_REPORT', operation: 'UPSERT', id: 'keine-uuid' },
      dailyChange(uuid(), '', null, 'UPSERT'),
      { type: 'UNKNOWN', operation: 'UPSERT', id: uuid() },
      dailyChange(uuid(), 'Unbekannt', 4, 'UPSERT'),
      { type: 'DAILY_REPORT', operation: 'UPSERT', id: uuid(), data: { date: '2026-10-05', text: 'x', orderIndex: 'abc' } },
    ))).expect(200);
    assert.deepEqual(statuses(r), ['APPLIED', 'REJECTED', 'REJECTED', 'REJECTED', 'REJECTED', 'REJECTED']);
    assert.equal(r.data.results[1].error.code, 'VALIDATION_FAILED');
    assert.equal(r.data.results[4].error.code, 'NOT_FOUND');
    assert.equal(r.data.results[5].error.code, 'INVALID_REQUEST_BODY');
    (await e.get(`/api/v1/daily-reports/${good}`, tok)).expect(200);

    const many = Array.from({ length: 101 }, () => dailyChange(uuid(), 'x', null, 'UPSERT'));
    (await e.post('/api/v1/sync/push', tok, push(...many))).expect(422);
    (await e.post('/api/v1/sync/push', tok, {})).expect(422);
    (await e.post('/api/v1/sync/push', tok, { changes: 'x' })).expect(400);
  });

  test('Pull-Pagination über den Cursor', async () => {
    const e = await newEnv();
    const tok = (await e.register()).access;
    const ids = Array.from({ length: 5 }, () => uuid());
    (await e.post('/api/v1/sync/push', tok, push(...ids.map((id) => dailyChange(id, 'Bericht', null, 'UPSERT'))))).expect(200);

    const seen = new Set<string>();
    let cursor = '0';
    let rounds = 0;
    for (;;) {
      const p = (await e.get(`/api/v1/sync/changes?limit=2&cursor=${cursor}`, tok)).expect(200);
      for (const c of p.data.changes) {
        assert.ok(!seen.has(c.id), `doppelte Änderung ${c.id}`);
        seen.add(c.id);
      }
      cursor = p.data.nextCursor;
      rounds++;
      if (p.data.hasMore !== true || rounds > 10) break;
    }
    assert.equal(rounds, 3); // 1 Profil + 5 Berichte = 6 Änderungen à 2
    for (const id of ids) assert.ok(seen.has(id), `Änderung fehlt ${id}`);
    (await e.get('/api/v1/sync/changes?cursor=-1', tok)).expect(400);
    (await e.get('/api/v1/sync/changes?cursor=abc', tok)).expect(400);
    (await e.get('/api/v1/sync/changes?cursor=5.0', tok)).expect(400);
  });

  test('Profil und Wochenberichte', async () => {
    const e = await newEnv();
    const s = await e.register();
    const weekly = uuid();
    const r = (await e.post('/api/v1/sync/push', s.access, push(
      { type: 'PROFILE', operation: 'UPSERT', id: s.userId, baseVersion: 1, data: { name: 'Max Muster', profession: 'Fachinformatiker' } },
      { type: 'WEEKLY_REPORT', operation: 'UPSERT', id: weekly, data: { weekStart: '2026-10-05', content: 'Woche' } },
      { type: 'PROFILE', operation: 'DELETE', id: s.userId, baseVersion: 2 },
    ))).expect(200);
    assert.deepEqual(statuses(r), ['APPLIED', 'APPLIED', 'REJECTED']);
    assert.equal((await e.get('/api/v1/profile', s.access)).data.name, 'Max Muster');
    const types = new Set((await e.get('/api/v1/sync/changes?cursor=0', s.access)).data.changes.map((c: { type: string }) => c.type));
    assert.deepEqual([...types].sort(), ['PROFILE', 'WEEKLY_REPORT']);
  });

  test('aktuelle Woche in der Zeitzone des Benutzers', async () => {
    // Sonntag, 4.10.2026, 23:30 UTC = Montag 01:30 in Berlin, aber noch Sonntag in New York.
    const fixed = new Date('2026-10-04T23:30:00Z');
    const e = await newEnv();
    const berlin = await e.register('', { timezone: 'Europe/Berlin' });
    const newYork = await e.register('', { timezone: 'America/New_York' });
    assert.equal((await e.get('/api/v1/weeks/current', berlin.access)).expect(200).data.timezone, 'Europe/Berlin');
    e.app.reports.now = () => fixed;
    assert.equal((await e.get('/api/v1/weeks/current', berlin.access)).data.weekStart, '2026-10-05');
    assert.equal((await e.get('/api/v1/weeks/current', newYork.access)).data.weekStart, '2026-09-28');
    assert.equal((await e.get('/api/v1/weeks/current', newYork.access)).data.today, '2026-10-04');
  });
});
