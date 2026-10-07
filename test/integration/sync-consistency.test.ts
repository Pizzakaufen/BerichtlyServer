// Während ein Gerät fortlaufend Änderungen abruft, schreiben zwei andere Geräte gleichzeitig Tages- und
// Wochenberichte. Am Ende muss der abrufende Client jede einzelne Änderung gesehen haben – kein Cursor darf
// über eine noch nicht sichtbare Änderung hinwegspringen.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { addDays } from '../../src/domain/date.ts';
import { needsDb, newEnv, uuid } from '../helpers.ts';

/** n-ter Montag ab 2000-01-03 – jede Woche nur einmal. */
const mondayAfter = (n: number) => addDays('2000-01-03', n * 7);

describe('Konsistenz des Abrufs', needsDb, () => {
  test('Pull verliert keine Änderungen bei gleichzeitigen Schreibvorgängen', async () => {
    const e = await newEnv();
    const tok = (await e.register()).access;
    const perWriter = 60;
    const written = new Set<string>();

    const writer = async (w: number) => {
      for (let i = 0; i < perWriter; i++) {
        const id = uuid();
        const r = i % 2 === 0
          ? await e.post('/api/v1/daily-reports', tok, { id, date: '2026-10-05', text: `w${w}-${i}` })
          : await e.post('/api/v1/weekly-reports', tok, { id, weekStart: mondayAfter(w * perWriter + i), content: 'x' });
        if (r.status === 201) written.add(id);
      }
    };

    const seen = new Set<string>();
    let cursor = '0';
    const pull = async () => {
      const p = (await e.get(`/api/v1/sync/changes?limit=7&cursor=${cursor}`, tok)).expect(200);
      for (const c of p.data.changes) seen.add(c.id);
      cursor = p.data.nextCursor;
      return p.data.hasMore === true;
    };

    let running = true;
    const writers = Promise.all([writer(0), writer(1)]).finally(() => {
      running = false;
    });
    while (running) await pull();
    await writers;
    while (await pull()) { /* restliche Seiten */ }

    assert.equal(written.size, 2 * perWriter);
    const missing = [...written].filter((id) => !seen.has(id));
    assert.equal(missing.length, 0, `${missing.length} Änderungen wurden beim Abruf übersprungen`);
  });
});
