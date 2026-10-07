// Leistungstest mit großen Datenmengen (nur mit BERICHTLY_PERF_TEST=1, dauert ca. 1 Minute):
// 200 000 Tagesberichte für ein Konto plus 100 000 für andere Konten. Geprüft wird, dass die häufigen Abfragen
// Indizes nutzen (keine Full-Table-Scans) und in vertretbarer Zeit antworten.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { migrate } from '../../src/db/migrate.ts';
import { Database } from '../../src/db/pool.ts';
import { PasswordHasher } from '../../src/security/password.ts';
import { silentLogger } from '../../src/util/logger.ts';
import { DEFAULT_PASSWORD, envOn, tempDatabase, testConfig, uuid } from '../helpers.ts';

const enabled = process.env.BERICHTLY_PERF_TEST === '1' && !!process.env.BERICHTLY_TEST_DATABASE_URL;

test('Leistung mit vielen Berichten', { skip: enabled ? false : 'nur mit BERICHTLY_PERF_TEST=1', timeout: 600_000 }, async (t) => {
  const tmp = await tempDatabase();
  if (!tmp) {
    t.skip('Testbenutzer darf keine Datenbanken anlegen (CREATEDB fehlt)');
    return;
  }
  t.after(() => tmp.drop());
  const db = Database.create(testConfig(tmp.overrides).database, () => {});
  t.after(() => db.close());
  await migrate(db, silentLogger());

  const hash = await new PasswordHasher().hash(DEFAULT_PASSWORD);
  const main = uuid();
  const start = performance.now();
  await db.query("INSERT INTO users (id, email, password_hash, timezone) VALUES ($1, 'viel@example.org', $2, 'Europe/Berlin')", [main, hash]);
  await db.query('INSERT INTO user_profiles (user_id) VALUES ($1)', [main]);
  await db.query(`INSERT INTO users (id, email, password_hash, timezone)
    SELECT gen_random_uuid(), 'u' || g || '@example.org', 'x', 'Europe/Berlin' FROM generate_series(1, 100) g`);
  // 200 000 Berichte für das Hauptkonto (ca. 27 Jahre zu je 20 Tätigkeiten pro Tag), 5 % gelöscht.
  await db.query(`INSERT INTO daily_reports (id, user_id, report_date, text, status, deleted_at)
    SELECT gen_random_uuid(), $1, DATE '2000-01-01' + (g / 20), 'Tätigkeit ' || g,
           (ARRAY['DRAFT','GENERATED','EDITED','FINALIZED'])[1 + g % 4], CASE WHEN g % 20 = 0 THEN now() END
    FROM generate_series(1, 200000) g`, [main]);
  // 100 000 Berichte verteilt auf 100 andere Konten.
  await db.query(`INSERT INTO daily_reports (id, user_id, report_date, text)
    SELECT gen_random_uuid(), u.id, DATE '2020-01-01' + (g % 2000), 'x'
    FROM (SELECT id, row_number() OVER () n FROM users WHERE email LIKE 'u%') u
    JOIN generate_series(1, 100000) g ON g % 100 = u.n - 1`);
  await db.query('ANALYZE');
  t.diagnostic(`Testdaten angelegt in ${Math.round(performance.now() - start)} ms`);

  // Ausführungspläne: Die Sync- und Listenabfragen dürfen daily_reports nicht vollständig durchsuchen.
  const plans: [string, string, unknown[]][] = [
    ['Sync-Abruf', 'SELECT id FROM daily_reports WHERE user_id = $1 AND change_seq > $2 ORDER BY change_seq LIMIT 501', [main, 150000]],
    ['Wochenübersicht', "SELECT id FROM daily_reports WHERE user_id = $1 AND deleted_at IS NULL AND report_date BETWEEN '2010-01-04' AND '2010-01-10'", [main]],
    ['Liste Monat', "SELECT id FROM daily_reports WHERE user_id = $1 AND deleted_at IS NULL AND report_date >= '2010-03-01' AND report_date <= '2010-03-31' ORDER BY report_date DESC LIMIT 50", [main]],
  ];
  for (const [name, sql, args] of plans) {
    const plan = (await db.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${sql}`, args)).rows.map((r) => r['QUERY PLAN']).join('\n');
    assert.ok(!plan.includes('Seq Scan on daily_reports'), `${name} nutzt keinen Index:\n${plan}`);
  }

  const e = await envOn(tmp.overrides);
  const s = (await e.login('viel@example.org', DEFAULT_PASSWORD)).expect(200).session();
  const mid = (await db.query<{ change_seq: number }>(
    'SELECT change_seq FROM daily_reports WHERE user_id = $1 ORDER BY change_seq OFFSET 150000 LIMIT 1', [main])).rows[0].change_seq;
  const measure = async (name: string, path: string) => {
    let best = Infinity;
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      (await e.get(path, s.access)).expect(200);
      best = Math.min(best, performance.now() - t0);
    }
    t.diagnostic(`${name.padEnd(38)} ${best.toFixed(1)} ms`);
    assert.ok(best < 2000, `${name} zu langsam: ${best} ms`);
  };
  await measure('Sync: erste Seite (500 Änderungen)', '/api/v1/sync/changes?cursor=0&limit=500');
  await measure('Sync: Seite ab Cursor (Mitte)', `/api/v1/sync/changes?limit=500&cursor=${mid}`);
  await measure('Sync: Status', '/api/v1/sync/status');
  await measure('Liste: Seite 1 (50)', '/api/v1/daily-reports?limit=50');
  await measure('Liste: Monat März 2010', '/api/v1/daily-reports?year=2010&month=3&limit=50');
  await measure('Liste: Status-Filter', '/api/v1/daily-reports?status=FINALIZED&limit=50');
  await measure('Liste: tiefe Seite (Seite 3000)', '/api/v1/daily-reports?limit=50&page=3000');
  await measure('Wochenübersicht', '/api/v1/weeks/2010-01-06');
  await e.close();
});
