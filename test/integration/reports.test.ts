import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { daily, needsDb, newEnv, type Res, uuid } from '../helpers.ts';

const texts = (r: Res) => r.data.map((x: { text: string }) => x.text);

describe('Tages- und Wochenberichte', needsDb, () => {
  test('Tagesbericht erstellen, abrufen, ändern, löschen', async () => {
    const e = await newEnv();
    const tok = (await e.register()).access;

    const created = (await e.post('/api/v1/daily-reports', tok, daily('2026-10-05', 'Kundenauftrag bearbeitet'))).expect(201);
    const id = created.data.id;
    assert.equal(created.data.version, 1);
    assert.equal(created.data.date, '2026-10-05');
    assert.match(created.data.createdAt, /Z$/);
    assert.equal((await e.get(`/api/v1/daily-reports/${id}`, tok)).expect(200).data.text, 'Kundenauftrag bearbeitet');

    const upd = (await e.put(`/api/v1/daily-reports/${id}`, tok,
      { ...daily('2026-10-05', 'Kundenauftrag abgeschlossen', 'EDITED'), version: 1 })).expect(200);
    assert.equal(upd.data.version, 2);
    assert.equal(upd.data.status, 'EDITED');

    // Veraltete Version → Konflikt, nichts wird überschrieben.
    const stale = (await e.put(`/api/v1/daily-reports/${id}`, tok, { ...daily('2026-10-05', 'Anderer Text'), version: 1 })).expect(409);
    assert.equal(stale.body.error.conflict.reason, 'VERSION_MISMATCH');
    assert.equal(stale.body.error.conflict.serverVersion, 2);
    assert.equal(stale.body.error.conflict.serverRecord.text, 'Kundenauftrag abgeschlossen');
    assert.equal((await e.get(`/api/v1/daily-reports/${id}`, tok)).data.text, 'Kundenauftrag abgeschlossen');

    (await e.delete(`/api/v1/daily-reports/${id}`, tok)).expect(400); // Version fehlt
    (await e.delete(`/api/v1/daily-reports/${id}?version=1`, tok)).expect(409); // veraltet
    (await e.delete(`/api/v1/daily-reports/${id}?version=2`, tok)).expect(204);
    (await e.get(`/api/v1/daily-reports/${id}`, tok)).expect(404);
    (await e.delete(`/api/v1/daily-reports/${id}?version=2`, tok)).expect(204); // idempotent
    const revive = (await e.put(`/api/v1/daily-reports/${id}`, tok, { ...daily('2026-10-05', 'Neu'), version: 3 })).expect(409);
    assert.equal(revive.body.error.conflict.reason, 'DELETED_ON_SERVER');
  });

  test('Erstellen mit Client-ID ist idempotent', async () => {
    const e = await newEnv();
    const tok = (await e.register()).access;
    const id = uuid();
    const body = { ...daily('2026-10-06', 'Netzwerk konfiguriert'), id };
    (await e.post('/api/v1/daily-reports', tok, body)).expect(201);
    assert.equal((await e.post('/api/v1/daily-reports', tok, body)).expect(200).data.version, 1);
    const other = (await e.post('/api/v1/daily-reports', tok, { ...daily('2026-10-06', 'Anderer Inhalt'), id })).expect(409);
    assert.equal(other.body.error.conflict.reason, 'ALREADY_EXISTS');
    assert.equal((await e.get('/api/v1/daily-reports', tok)).body.meta.total, 1);
  });

  test('Liste mit Filtern, Sortierung und Pagination', async () => {
    const e = await newEnv();
    const tok = (await e.register()).access;
    for (const [d, t, s] of [['2026-09-28', 'A', 'FINALIZED'], ['2026-09-30', 'B', 'DRAFT'], ['2026-10-02', 'C', 'EDITED'],
      ['2026-10-07', 'D', 'DRAFT']]) {
      (await e.post('/api/v1/daily-reports', tok, daily(d, t, s))).expect(201);
    }
    const check = async (q: string, ...want: string[]) =>
      assert.deepEqual(texts((await e.get(`/api/v1/daily-reports?${q}`, tok)).expect(200)), want, q);
    await check('from=2026-09-29&to=2026-10-02&sort=date_asc', 'B', 'C');
    await check('status=DRAFT,FINALIZED', 'D', 'B', 'A');
    await check('date=2026-10-07', 'D');
    await check('limit=3&page=2', 'A');
    await check('year=2026&month=9', 'B', 'A');
    await check('isoYear=2026&isoWeek=40', 'C', 'B', 'A');

    const p1 = await e.get('/api/v1/daily-reports?limit=3&page=1', tok);
    assert.equal(p1.data.length, 3);
    assert.deepEqual(p1.body.meta, { page: 1, limit: 3, total: 4, hasMore: true });
    for (const bad of ['limit=0', 'limit=1000', 'page=0', 'status=UNKNOWN', 'from=2026-13-01', 'sort=random',
      'from=2026-10-05&to=2026-10-01', 'month=5', 'isoYear=2026&isoWeek=54', 'limit=abc']) {
      assert.equal((await e.get(`/api/v1/daily-reports?${bad}`, tok)).expect(400).code, 'INVALID_PARAMETER', bad);
    }
  });

  test('ungültige Berichtsdaten', async () => {
    const e = await newEnv();
    const tok = (await e.register()).access;
    const cases: [Record<string, unknown>, string][] = [
      [{ date: '2026-10-05' }, 'text'],
      [daily('05.10.2026', 'x'), 'date'],
      [daily('1999-12-31', 'x'), 'date'],
      [daily('2026-10-05', 'x', 'DONE'), 'status'],
      [daily('2026-10-05', '   '), 'text'],
      [daily('2026-10-05', 'ä'.repeat(5001)), 'text'],
      [daily('2026-10-05', 'Null\u0000Byte'), 'text'],
      [{ ...daily('2026-10-05', 'x'), id: 'keine-uuid' }, 'id'],
      [{ ...daily('2026-10-05', 'x'), orderIndex: -1 }, 'orderIndex'],
    ];
    for (const [body, field] of cases) {
      const r = (await e.post('/api/v1/daily-reports', tok, body)).expect(422);
      assert.ok(r.fields.includes(field), `Fehler für ${field} erwartet: ${r.raw}`);
    }
    // 5000 Umlaute sind erlaubt (Zeichen, nicht Bytes)
    (await e.post('/api/v1/daily-reports', tok, daily('2026-10-05', 'ä'.repeat(5000)))).expect(201);
    (await e.get('/api/v1/daily-reports/123', tok)).expect(400);
    (await e.get(`/api/v1/daily-reports/${uuid()}`, tok)).expect(404);
  });

  test('Wochenübersicht Montag bis Sonntag', async () => {
    const e = await newEnv();
    const tok = (await e.register()).access;
    for (const d of ['2026-10-04', '2026-10-05', '2026-10-08', '2026-10-11', '2026-10-12']) {
      (await e.post('/api/v1/daily-reports', tok, daily(d, `Tätigkeit ${d}`))).expect(201);
    }
    (await e.post('/api/v1/weekly-reports', tok, { weekStart: '2026-10-05', content: 'KW 41' })).expect(201);

    const w = (await e.get('/api/v1/weeks/2026-10-11', tok)).expect(200); // Sonntag
    assert.equal(w.data.weekStart, '2026-10-05');
    assert.equal(w.data.weekEnd, '2026-10-11');
    assert.equal(w.data.isoWeek, 41);
    assert.equal(w.data.days.length, 7);
    assert.equal(w.data.days[0].dayOfWeek, 'MONDAY');
    assert.equal(w.data.days[6].dayOfWeek, 'SUNDAY');
    const got = w.data.days.flatMap((d: { dailyReports: { text: string }[] }) => d.dailyReports.map((r) => r.text));
    assert.deepEqual(got, ['Tätigkeit 2026-10-05', 'Tätigkeit 2026-10-08', 'Tätigkeit 2026-10-11']);
    assert.equal(w.data.weeklyReport.content, 'KW 41');
    (await e.get('/api/v1/weeks/2026-02-30', tok)).expect(400);
    assert.equal((await e.get('/api/v1/weeks/2026/41', tok)).expect(200).data.weekStart, '2026-10-05');
    (await e.get('/api/v1/weeks/2025/53', tok)).expect(400); // 2025 hat nur 52 ISO-Wochen
  });

  test('ISO-Woche über den Jahreswechsel', async () => {
    const e = await newEnv();
    const tok = (await e.register()).access;
    const w = (await e.get('/api/v1/weeks/2027-01-01', tok)).expect(200);
    assert.equal(w.data.weekStart, '2026-12-28');
    assert.equal(w.data.weekEnd, '2027-01-03');
    assert.equal(w.data.isoYear, 2026);
    assert.equal(w.data.isoWeek, 53);
  });

  test('ein aktiver Wochenbericht pro Woche', async () => {
    const e = await newEnv();
    const tok = (await e.register()).access;
    const first = (await e.post('/api/v1/weekly-reports', tok, {
      weekStart: '2026-10-05', content: 'Erster', status: 'GENERATED', generatedAt: '2026-10-09T15:00:00.123Z',
    })).expect(201);
    assert.equal(first.data.weekEnd, '2026-10-11');
    assert.equal(first.data.generatedAt, '2026-10-09T15:00:00.123Z');
    const dup = (await e.post('/api/v1/weekly-reports', tok, { weekStart: '2026-10-05', content: 'Zweiter' })).expect(409);
    assert.equal(dup.body.error.conflict.reason, 'DUPLICATE_WEEK');
    assert.equal(dup.body.error.conflict.serverRecord.content, 'Erster');
    (await e.delete(`/api/v1/weekly-reports/${first.data.id}?version=1`, tok)).expect(204);
    (await e.post('/api/v1/weekly-reports', tok, { weekStart: '2026-10-05', content: 'Neu' })).expect(201);
    (await e.post('/api/v1/weekly-reports', tok, { weekStart: '2026-10-07' })).expect(422);

    const list = (await e.get('/api/v1/weekly-reports?from=2026-10-01&to=2026-10-31', tok)).expect(200);
    assert.equal(list.data.length, 1);
    assert.equal(list.data[0].content, 'Neu');
  });
});
