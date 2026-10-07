// Upgrade-Pfad 1.0 Alpha → 1.1 (Go) → 1.2 (Node.js) auf einer eigenen Datenbank: Bestandsdaten bleiben
// unverändert, Passwörter, Sitzungen, Refresh Tokens und Sync-Operationen aus 1.1 funktionieren weiter.

import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { describe, test } from 'node:test';
import { latestSchemaVersion, migrate, migrationStatus } from '../../src/db/migrate.ts';
import { Database } from '../../src/db/pool.ts';
import { PasswordHasher } from '../../src/security/password.ts';
import { silentLogger } from '../../src/util/logger.ts';
import { envOn, needsDb, tempDatabase, testConfig, uuid } from '../helpers.ts';

// Von Berichtly Server 1.1 (Go, golang.org/x/crypto/argon2) erzeugter Hash für "Bestandspasswort-aus-1.1".
const GO_PASSWORD = 'Bestandspasswort-aus-1.1';
const GO_HASH = '$argon2id$v=19$m=19456,t=2,p=1$9WeVy1E1T+1/oMTqtgGiBw$g6ruh5XxkMrD1DxRneHnX6sEUkqJTA4ytcZcoHemQ7Q';

describe('Upgrade 1.0 → 1.1 → 1.2', needsDb, () => {
  test('Argon2-Hashes aus 1.1 (Go) werden erkannt', async () => {
    const h = new PasswordHasher();
    assert.equal(await h.verify(GO_PASSWORD, GO_HASH), true);
    assert.equal(await h.verify('falsch', GO_HASH), false);
    assert.equal(h.needsRehash(GO_HASH), false);
  });

  test('ohne Datenverlust, Sitzungen und Sync-Operationen bleiben gültig', async (t) => {
    const tmp = await tempDatabase();
    if (!tmp) {
      t.skip('Testbenutzer darf keine Datenbanken anlegen (CREATEDB fehlt)');
      return;
    }
    t.after(() => tmp.drop());
    const quiet = silentLogger();
    const db = Database.create(testConfig(tmp.overrides).database, () => {});
    t.after(() => db.close());
    const exec = (sql: string, args: unknown[] = []) => db.query(sql, args);

    // 1. Installation von 1.0 Alpha (nur Migration 0001) mit realistischen Bestandsdaten.
    assert.equal(await migrate(db, quiet, 1), 1);
    const users = [uuid(), uuid()];
    const device = uuid();
    const deviceRef = uuid();
    const otherHash = await new PasswordHasher().hash('korrekt-Pferd-Batterie-42');
    for (const [i, u] of users.entries()) {
      await exec("INSERT INTO users (id, email, password_hash, timezone) VALUES ($1, $2, $3, 'Europe/Berlin')",
        [u, `bestand${i}@example.org`, i === 0 ? GO_HASH : otherHash]);
      await exec(`INSERT INTO user_profiles (user_id, name, profession, company, training_start, writing_style)
        VALUES ($1, $2, 'Fachinformatiker', 'Muster GmbH', '2025-08-01', 'FORMAL')`, [u, `Azubi ${i}`]);
    }
    await exec("INSERT INTO devices (id, user_id, device_id, name, last_pull_at, last_pull_cursor) VALUES ($1, $2, $3, 'Pixel', now(), 5)",
      [deviceRef, users[0], device]);
    const dailyIds: string[] = [];
    for (let i = 0; i < 300; i++) {
      const id = uuid();
      dailyIds.push(id);
      await exec(`INSERT INTO daily_reports (id, user_id, report_date, text, note, order_index, status, version, last_device_ref)
        VALUES ($1, $2, DATE '2026-01-05' + $3::int, $4, 'Notiz', $5, 'EDITED', 2, $6)`,
      [id, users[i % 2], Math.floor(i / 3), `Tätigkeit ${i} mit Umlauten äöüß`, i % 3, deviceRef]);
    }
    await exec("UPDATE daily_reports SET deleted_at = now(), text = '', note = '' WHERE id = $1", [dailyIds[0]]); // Tombstone
    await exec(`INSERT INTO weekly_reports (id, user_id, week_start, week_end, iso_year, iso_week, content, status, generated_at)
      VALUES ($1, $2, '2026-01-05', '2026-01-11', 2026, 2, 'Wochenbericht KW 2', 'FINALIZED', now())`, [uuid(), users[0]]);

    // 2. Upgrade auf 1.1 und Betrieb mit 1.1: Sitzung mit Refresh Token und eine verarbeitete Sync-Operation.
    assert.equal(await migrate(db, quiet, 2), 1);
    const session = uuid();
    const refresh = 'brt_' + randomBytes(32).toString('base64url');
    await exec("INSERT INTO sessions (id, user_id, device_ref, expires_at) VALUES ($1, $2, $3, now() + interval '30 days')",
      [session, users[0], deviceRef]);
    await exec("INSERT INTO refresh_tokens (id, session_id, token_hash, expires_at) VALUES ($1, $2, $3, now() + interval '30 days')",
      [uuid(), session, createHash('sha256').update(refresh).digest()]);
    const goOperation = uuid();
    await exec(`INSERT INTO sync_operations (user_id, operation_id, device_ref, entity_type, entity_id, request_hash, result)
      VALUES ($1, $2, $3, 'DAILY_REPORT', $4, $5, $6)`,
    [users[0], goOperation, deviceRef, dailyIds[2], randomBytes(32), JSON.stringify({ status: 'APPLIED', version: 2, changeSeq: 7 })]);

    const fingerprint = async () => (await db.query<{ fp: string }>(`SELECT md5(string_agg(x, '|' ORDER BY x)) AS fp FROM (
      SELECT concat_ws(',', id, user_id, report_date, text, note, order_index, status, version, created_at, deleted_at, change_seq) x FROM daily_reports
      UNION ALL SELECT concat_ws(',', id, user_id, week_start, content, status, version, generated_at, change_seq) FROM weekly_reports
      UNION ALL SELECT concat_ws(',', user_id, name, profession, company, training_start, writing_style, version) FROM user_profiles
      UNION ALL SELECT concat_ws(',', id, email, password_hash, timezone, created_at) FROM users
      UNION ALL SELECT concat_ws(',', id, user_id, device_id, name, last_pull_cursor, sync_status) FROM devices
      UNION ALL SELECT concat_ws(',', id, user_id, device_ref, expires_at) FROM sessions
      UNION ALL SELECT concat_ws(',', id, session_id, token_hash, expires_at) FROM refresh_tokens
      UNION ALL SELECT concat_ws(',', user_id, operation_id, entity_type, entity_id, request_hash, result) FROM sync_operations) t`)).rows[0].fp;
    const before = await fingerprint();

    // 3. Upgrade auf 1.2 (Node.js): nur additive Änderungen.
    assert.equal(await migrate(db, quiet), latestSchemaVersion() - 2);
    assert.equal(await fingerprint(), before, 'Bestandsdaten wurden durch die Migration verändert');
    assert.equal((await db.query('SELECT hash_format FROM sync_operations WHERE operation_id = $1', [goOperation])).rows[0].hash_format, 1);

    // 4. Die aktualisierte Installation ist über die API voll nutzbar.
    const e = await envOn(tmp.overrides);
    // Refresh Token aus 1.1 funktioniert (Sitzung überlebt das Upgrade) und wird rotiert.
    const rotated = (await e.post('/api/v1/auth/refresh', '', { refreshToken: refresh })).expect(200).session();
    assert.equal(rotated.sessionId, session);
    // Passwort-Hash aus 1.1 (Go) funktioniert.
    const s = (await e.post('/api/v1/auth/login', '', {
      email: 'bestand0@example.org', password: GO_PASSWORD, device: { id: device, name: 'Pixel' },
    })).expect(200).session();
    assert.equal((await e.get('/api/v1/daily-reports?limit=1', s.access)).body.meta.total, 149); // 150 minus Tombstone
    assert.equal((await e.get('/api/v1/profile', s.access)).data.name, 'Azubi 0');
    assert.equal((await e.get('/api/v1/devices?includeRevoked=true', s.access)).body.meta.total, 1, 'Gerät dupliziert');
    const full = (await e.get('/api/v1/sync/changes?cursor=0&limit=500', s.access)).expect(200);
    assert.equal(full.data.changes.length, 150 + 1 + 1); // Tagesberichte (inkl. Tombstone) + Woche + Profil

    // Wiederholung einer von 1.1 verarbeiteten Operation liefert das gespeicherte Ergebnis …
    const replay = (await e.post('/api/v1/sync/push', s.access, { changes: [{
      operationId: goOperation, type: 'DAILY_REPORT', operation: 'UPSERT', id: dailyIds[2], baseVersion: 1,
      data: { date: '2026-01-05', text: 'egal' },
    }] })).expect(200).data.results[0];
    assert.equal(replay.status, 'APPLIED');
    assert.equal(replay.replayed, true);
    assert.equal(replay.version, 2);
    // … dieselbe operationId für einen anderen Datensatz wird abgelehnt.
    const misuse = (await e.post('/api/v1/sync/push', s.access, { changes: [{
      operationId: goOperation, type: 'DAILY_REPORT', operation: 'UPSERT', id: dailyIds[4], baseVersion: 2,
      data: { date: '2026-01-06', text: 'x' },
    }] })).expect(200).data.results[0];
    assert.equal(misuse.error.code, 'OPERATION_ID_REUSED');

    // Bestehender Bericht (Version 2 aus 1.0) lässt sich mit Versionsprüfung ändern.
    const upd = (await e.put(`/api/v1/daily-reports/${dailyIds[2]}`, s.access,
      { version: 2, date: '2026-01-05', text: 'Nach Upgrade geändert' })).expect(200);
    assert.equal(upd.data.version, 3);
    (await e.get(`/api/v1/daily-reports/${dailyIds[1]}`, s.access)).expect(404); // gehört users[1]

    // 5. Nachträglich veränderte Migration wird erkannt und blockiert.
    await exec("UPDATE schema_migrations SET checksum = 'manipuliert' WHERE version = 1");
    assert.equal((await migrationStatus(db))[0].state, 'modified');
    await assert.rejects(migrate(db, quiet), /verändert/);
    await e.close();
  });
});
