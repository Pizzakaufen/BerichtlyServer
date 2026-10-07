// Realistische Abläufe mit mehreren Android-Geräten (lokale Datenbank nur so weit nachgebildet, wie nötig).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { invalidateSyncCursors } from '../../src/db/repositories/maintenance.ts';
import { Device, op, serverCount } from '../device-sim.ts';
import { needsDb, newEnv, uuid } from '../helpers.ts';

describe('Sync-Szenarien', needsDb, () => {
  test('neues Gerät mit bestehendem Berichtsheft', async () => {
    const e = await newEnv();
    const email = 'heft@example.org';
    const phone = await Device.create(e, email, true);

    // Bestehendes Berichtsheft: 250 lokale Berichte in Paketen zu je 100 hochladen.
    const ops = Array.from({ length: 250 }, (_, i) => op(uuid(), uuid(), null, 'UPSERT', `Bericht ${String(i).padStart(3, '0')}`));
    for (let start = 0; start < ops.length; start += 100) {
      const r = await phone.sync(...ops.slice(start, start + 100));
      for (const res of r.data.push.results) assert.equal(res.status, 'APPLIED', r.raw);
    }
    assert.equal(await serverCount(e, phone.s.access), 250);

    // Neues Tablet mit leerer lokaler Datenbank: vollständiger Abruf über mehrere Seiten.
    const tablet = await Device.create(e, email, false);
    await tablet.sync();
    assert.equal(tablet.active().size, 250);
    const st = await e.get('/api/v1/sync/status', tablet.s.access);
    assert.equal(st.data.device.syncStatus, 'SUCCESS');
    assert.equal(st.data.device.lastSuccessfulCursor, tablet.cursor);
    assert.ok(st.data.device.lastSyncAt);
  });

  test('Änderungen auf mehreren Geräten und Löschung', async () => {
    const e = await newEnv();
    const email = 'multi@example.org';
    const a = await Device.create(e, email, true);
    const b = await Device.create(e, email, false);
    const r1 = uuid();
    const r2 = uuid();
    await a.sync(op(uuid(), r1, null, 'UPSERT', 'von A'));
    await b.sync(op(uuid(), r2, null, 'UPSERT', 'von B'));
    await a.sync();
    assert.equal(a.active().size, 2);
    assert.equal(b.active().size, 2);

    // B ändert r1, A löscht r2 – unabhängige Änderungen, keine Konflikte.
    await b.sync(op(uuid(), r1, b.local.get(r1)!.version, 'UPSERT', 'von A, ergänzt von B'));
    await a.sync(op(uuid(), r2, a.local.get(r2)!.version, 'DELETE', ''));
    await b.sync();
    await a.sync();
    for (const [name, d] of [['A', a], ['B', b]] as const) {
      assert.deepEqual([...d.active()], [[r1, 'von A, ergänzt von B']], `Gerät ${name}`);
      assert.ok(d.local.get(r2)!.deleted, `Gerät ${name} kennt die Löschung nicht`);
    }
    assert.equal(await serverCount(e, a.s.access), 1);
  });

  test('echter Konflikt zwischen zwei Geräten', async () => {
    const e = await newEnv();
    const email = 'konflikt@example.org';
    const a = await Device.create(e, email, true);
    const b = await Device.create(e, email, false);
    const id = uuid();
    await a.sync(op(uuid(), id, null, 'UPSERT', 'Original'));
    await b.sync();

    // Beide Geräte ändern denselben Bericht offline auf Basis von Version 1.
    await a.sync(op(uuid(), id, 1, 'UPSERT', 'Fassung A'));
    const r = (await e.post('/api/v1/sync', b.s.access, { cursor: b.cursor, changes: [op(uuid(), id, 1, 'UPSERT', 'Fassung B')] })).expect(200);
    const res = r.data.push.results[0];
    assert.equal(res.status, 'CONFLICT');
    assert.equal(res.conflict.reason, 'VERSION_MISMATCH');
    assert.equal(res.conflict.serverRecord.text, 'Fassung A');
    // Keine stille Überschreibung: Server hat weiterhin Fassung A.
    assert.equal((await e.get(`/api/v1/daily-reports/${id}`, a.s.access)).data.text, 'Fassung A');
    // B meldet einen Abschluss mit ungelöstem Konflikt → Status CONFLICT.
    const done = (await e.post('/api/v1/sync/complete', b.s.access,
      { result: 'SUCCESS', cursor: r.data.pull.nextCursor, unresolvedConflicts: 1 })).expect(200);
    assert.equal(done.data.syncStatus, 'CONFLICT');
    assert.equal(done.data.unresolvedConflicts, 1);
    // Benutzer entscheidet sich für Fassung B: erneut senden auf Basis der Serverversion.
    const resolve = (await e.post('/api/v1/sync', b.s.access,
      { cursor: b.cursor, changes: [op(uuid(), id, res.conflict.serverVersion, 'UPSERT', 'Fassung B')] })).expect(200);
    assert.equal(resolve.data.push.results[0].status, 'APPLIED');
    const ok = (await e.post('/api/v1/sync/complete', b.s.access, { result: 'SUCCESS', cursor: resolve.data.pull.nextCursor })).expect(200);
    assert.equal(ok.data.syncStatus, 'SUCCESS');
    assert.equal(ok.data.unresolvedConflicts, 0);
  });

  test('wiederholte Operation und Netzwerkabbruch', async () => {
    const e = await newEnv();
    const d = await Device.create(e, 'netz@example.org', true);
    const id = uuid();
    const createOp = uuid();

    // 1. Push wird verarbeitet, die Antwort geht verloren (Netzwerkabbruch) …
    (await e.post('/api/v1/sync/push', d.s.access, { changes: [op(createOp, id, null, 'UPSERT', 'Erfasst')] })).expect(200);
    // … in der Zwischenzeit ändert ein anderes Gerät den Bericht …
    const other = await Device.create(e, 'netz@example.org', false);
    await other.sync();
    await other.sync(op(uuid(), id, 1, 'UPSERT', 'Anderes Gerät'));
    // … dann wiederholt das erste Gerät exakt dieselbe Operation.
    const replay = (await e.post('/api/v1/sync/push', d.s.access, { changes: [op(createOp, id, null, 'UPSERT', 'Erfasst')] })).expect(200);
    const res = replay.data.results[0];
    assert.equal(res.status, 'APPLIED');
    assert.equal(res.replayed, true);
    assert.equal(res.version, 1);
    assert.equal(await serverCount(e, d.s.access), 1);
    assert.equal((await e.get(`/api/v1/daily-reports/${id}`, d.s.access)).data.text, 'Anderes Gerät');

    // Dieselbe operationId für eine andere Änderung wird abgelehnt.
    const misuse = await e.post('/api/v1/sync/push', d.s.access, { changes: [op(createOp, id, null, 'UPSERT', 'Etwas anderes')] });
    assert.equal(misuse.data.results[0].error.code, 'OPERATION_ID_REUSED');

    // 2. Abbruch während des Abrufs: Der Cursor wird erst nach lokaler Übernahme gespeichert; ein erneuter
    //    Abruf vom alten Cursor liefert dieselben Daten – nichts fehlt, nichts doppelt.
    const before = d.cursor;
    const p1 = (await e.get(`/api/v1/sync/changes?limit=1&cursor=${before}`, d.s.access)).expect(200);
    const p2 = (await e.get(`/api/v1/sync/changes?limit=1&cursor=${before}`, d.s.access)).expect(200);
    assert.equal(p1.data.changes[0].id, p2.data.changes[0].id);
    assert.equal(p1.data.nextCursor, p2.data.nextCursor);
    // 3. Fehlgeschlagener Vorgang wird nicht als Erfolg gespeichert.
    const fail = (await e.post('/api/v1/sync/complete', d.s.access, { result: 'FAILED', errorCode: 'NETWORK_ERROR' })).expect(200);
    assert.equal(fail.data.syncStatus, 'FAILED');
    assert.equal(fail.data.lastSyncAt, null);
    assert.equal(fail.data.lastSyncErrorCode, 'NETWORK_ERROR');
    await d.sync();
    const st = await e.get('/api/v1/sync/status', d.s.access);
    assert.equal(st.data.device.syncStatus, 'SUCCESS');
    assert.ok(st.data.device.lastFailedSyncAt);
  });

  test('gleichzeitige doppelte Übertragung erzeugt kein Duplikat', async () => {
    const e = await newEnv();
    const d = await Device.create(e, 'parallel@example.org', true);
    const id = uuid();
    const opId = uuid();
    const results = await Promise.all(Array.from({ length: 8 }, () =>
      e.post('/api/v1/sync/push', d.s.access, { changes: [op(opId, id, null, 'UPSERT', 'Einmal')] })));
    assert.deepEqual(results.map((r) => r.data.results[0].status), Array(8).fill('APPLIED'));
    assert.equal(await serverCount(e, d.s.access), 1);
    const ops = await e.db.query('SELECT count(*) AS n FROM sync_operations WHERE operation_id = $1', [opId]);
    assert.equal(ops.rows[0].n, 1);
  });

  test('kombinierter Endpunkt und Herkunft', async () => {
    const e = await newEnv();
    const d = await Device.create(e, 'echo@example.org', true);
    const id = uuid();
    const opId = uuid();
    const change = { ...op(opId, id, null, 'UPSERT', 'Mit Herkunft'), clientLocalId: 'room:42' };
    const r = (await e.post('/api/v1/sync', d.s.access, { cursor: '0', changes: [change] })).expect(200);
    const own = r.data.pull.changes.find((c: { id: string }) => c.id === id);
    assert.equal(own.echo, true, 'eigene Änderung nicht als echo markiert');
    assert.equal(own.data.clientLocalId, 'room:42');
    assert.equal(own.data.clientUpdatedAt, '2026-10-05T07:00:00.000Z');
    assert.equal(own.data.createdByDeviceId, d.id);
    assert.equal(own.data.lastOperationId, opId);
    // Serverzeit (updatedAt) und Clientzeit sind getrennt; die (falsche) Clientzeit beeinflusst nichts.
    const rec = await e.get(`/api/v1/daily-reports/${id}`, d.s.access);
    assert.notEqual(rec.data.updatedAt, rec.data.clientUpdatedAt);
    assert.equal(r.data.device.deviceId, d.id);
    assert.ok(r.data.device.lastSyncStartedAt);
    (await e.post('/api/v1/sync', d.s.access, { cursor: '-5' })).expect(400);
    (await e.post('/api/v1/sync', d.s.access, { limit: 0 })).expect(422);
    (await e.post('/api/v1/sync/complete', d.s.access, { result: 'SUCCESS', cursor: '999999999' })).expect(422);
    (await e.post('/api/v1/sync/complete', d.s.access, { result: 'VIELLEICHT' })).expect(422);
    (await e.post('/api/v1/sync/complete', d.s.access, { result: 'FAILED', errorCode: 'kaputt<script>' })).expect(422);
    const bad = { ...op(uuid(), uuid(), null, 'UPSERT', 'x'), clientLocalId: '<script>' };
    assert.equal((await e.post('/api/v1/sync/push', d.s.access, { changes: [bad] })).data.results[0].status, 'REJECTED');
  });

  test('abgelaufener Cursor nach Tombstone-Bereinigung', async () => {
    const e = await newEnv();
    const email = 'alt@example.org';
    const a = await Device.create(e, email, true);
    const old = await Device.create(e, email, false);
    const id = uuid();
    await a.sync(op(uuid(), id, null, 'UPSERT', 'Wird gelöscht'));
    await old.sync(); // altes Gerät kennt den Bericht …
    await a.sync(op(uuid(), id, 1, 'DELETE', ''));
    const keep = uuid();
    await a.sync(op(uuid(), keep, null, 'UPSERT', 'Bleibt'));

    // Tombstone künstlich altern lassen und Wartung ausführen.
    await e.ageRow('daily_reports', 'deleted_at', '400 days', id);
    const res = await e.app.runMaintenance();
    assert.equal(res.tombstonesPurged, 1);
    assert.equal((await e.db.query('SELECT count(*) AS n FROM daily_reports WHERE id = $1', [id])).rows[0].n, 0);
    // … hat die Löschung aber nie abgerufen: Sein Cursor ist jetzt ungültig.
    assert.equal((await e.get(`/api/v1/sync/changes?cursor=${old.cursor}`, old.s.access)).expect(410).code, 'SYNC_CURSOR_EXPIRED');
    (await e.post('/api/v1/sync', old.s.access, { cursor: old.cursor })).expect(410);
    // Vollständige Neusynchronisierung liefert den korrekten Stand (gelöschter Bericht fehlt).
    const full = (await e.get('/api/v1/sync/changes?cursor=0', old.s.access)).expect(200);
    assert.ok(!full.raw.includes(id) && full.raw.includes(keep));
    assert.notEqual((await e.get('/api/v1/sync/status', old.s.access)).data.minValidCursor, '0');
    // Aktuelle Geräte sind nicht betroffen.
    (await e.get(`/api/v1/sync/changes?cursor=${a.cursor}`, a.s.access)).expect(200);

    // Neusynchronisierung über mehrere Seiten (limit=1): Die Zwischen-Cursor liegen numerisch unter der
    // Untergrenze, sind aber neu ausgestellt und müssen gültig sein – sonst entstünde eine Endlosschleife.
    old.cursor = '0';
    old.local = new Map();
    let pages = 0;
    for (;;) {
      const p = (await e.get(`/api/v1/sync/changes?limit=1&cursor=${old.cursor}`, old.s.access)).expect(200);
      old.apply(p.data);
      pages++;
      if (p.data.hasMore !== true || pages > 20) break;
    }
    assert.deepEqual([...old.active()], [[keep, 'Bleibt']]);
    assert.ok(pages >= 2);
    (await e.get(`/api/v1/sync/changes?cursor=${old.cursor}`, old.s.access)).expect(200);
  });

  // Nach dem Einspielen eines Backups springen die Änderungsnummern zurück. `reset-sync-cursors` erklärt
  // alle bisherigen Cursor für ungültig, damit kein Gerät neue Änderungen übersieht.
  test('Cursor zurücksetzen nach Wiederherstellung', async () => {
    const e = await newEnv();
    const d = await Device.create(e, 'restore@example.org', true);
    await d.sync(op(uuid(), uuid(), null, 'UPSERT', 'vorher'));
    const before = d.cursor;
    await invalidateSyncCursors(e.db);
    (await e.get(`/api/v1/sync/changes?cursor=${before}`, d.s.access)).expect(410);
    d.cursor = '0';
    d.local = new Map();
    await d.sync(op(uuid(), uuid(), null, 'UPSERT', 'nachher'));
    assert.equal(d.active().size, 2);
    (await e.get(`/api/v1/sync/changes?cursor=${d.cursor}`, d.s.access)).expect(200);
  });
});
