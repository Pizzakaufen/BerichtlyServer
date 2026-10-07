import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dateInRange, isoWeekFromNumber, monthRange, parseDate, todayIn, weekContaining, weekDays } from '../../src/domain/date.ts';

test('Woche beginnt immer am Montag', () => {
  const w = weekContaining('2026-10-11'); // Sonntag
  assert.equal(w.start, '2026-10-05');
  assert.equal(w.end, '2026-10-11');
  assert.equal(weekDays(w).length, 7);
  assert.deepEqual(weekContaining('2026-10-05'), w);
  const y = weekContaining('2027-01-03');
  assert.deepEqual([y.year, y.week], [2026, 53]);
  assert.equal(weekContaining('2027-01-04').week, 1);
});

test('Datum parsen', () => {
  for (const bad of ['2026-02-30', '05.10.2026', '2026-1-5', '', '2026-10-05T00:00:00Z', '2026-13-01', '+2026-10-05']) {
    assert.equal(parseDate(bad), null, `"${bad}" akzeptiert`);
  }
  const leap = parseDate('2024-02-29');
  assert.ok(leap && dateInRange(leap), 'Schalttag abgelehnt');
  assert.equal(dateInRange(parseDate('1999-12-31')!), false);
});

test('ISO-Woche aus Jahr und Nummer', () => {
  const cases: [number, number, string | null][] = [
    [2026, 1, '2025-12-29'],
    [2026, 53, '2026-12-28'], // 2026 beginnt an einem Donnerstag → 53 Wochen
    [2025, 53, null],
    [2020, 53, '2020-12-28'],
    [2021, 1, '2021-01-04'],
    [2026, 0, null],
    [1999, 10, null],
  ];
  for (const [year, week, start] of cases) assert.equal(isoWeekFromNumber(year, week)?.start ?? null, start, `${year}/${week}`);
  assert.deepEqual(monthRange(2024, 2), ['2024-02-01', '2024-02-29']);
  assert.equal(monthRange(2026, 12)[1], '2026-12-31');
});

test('"heute" in der Zeitzone des Benutzers', () => {
  const t = new Date('2026-10-04T23:30:00Z');
  assert.equal(todayIn(t, 'Europe/Berlin'), '2026-10-05');
  assert.equal(todayIn(t, 'America/New_York'), '2026-10-04');
  assert.equal(todayIn(t, 'UTC'), '2026-10-04');
});
