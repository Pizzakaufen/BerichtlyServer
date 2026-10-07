// Versionierte Migrationen (migrations/NNNN_beschreibung.sql). Kompatibel mit Berichtly Server 1.0/1.1:
// dieselbe Tabelle schema_migrations und dieselben Prüfsummen (SHA-256 des Dateiinhalts).

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import type { Logger } from '../util/logger.ts';
import type { Database } from './pool.ts';

const MIGRATION_LOCK_ID = 726_174_520_031; // gleiche Sperre wie in 1.1 (nie zwei Migrationsläufe parallel)
const DIR = new URL('./migrations/', import.meta.url);

interface Migration {
  version: number;
  name: string;
  sql: string;
  checksum: string;
}

export function loadMigrations(): Migration[] {
  const result: Migration[] = [];
  for (const file of readdirSync(DIR).filter((f) => f.endsWith('.sql'))) {
    const m = /^(\d+)_(.+)\.sql$/.exec(file);
    if (!m || Number(m[1]) <= 0) throw new Error(`ungültiger Migrationsdateiname: ${file}`);
    const content = readFileSync(new URL(file, DIR));
    result.push({
      version: Number(m[1]),
      name: m[2],
      sql: content.toString('utf8'),
      checksum: createHash('sha256').update(content).digest('hex'),
    });
  }
  result.sort((a, b) => a.version - b.version);
  for (let i = 1; i < result.length; i++) {
    if (result[i].version === result[i - 1].version) throw new Error(`doppelte Migrationsversion ${result[i].version}`);
  }
  return result;
}

export const latestSchemaVersion = () => {
  const m = loadMigrations();
  return m.length ? m[m.length - 1].version : 0;
};

/**
 * Wendet fehlende Migrationen bis einschließlich target an (0 = alle). Jede Migration läuft in einer
 * eigenen Transaktion; der gesamte Lauf ist über eine Advisory-Lock gegen parallele Ausführung
 * geschützt. Bereits angewendete Migrationen werden per Prüfsumme kontrolliert.
 */
export async function migrate(db: Database, log: Logger, target = 0): Promise<number> {
  const migrations = loadMigrations();
  const client = await db.pool.connect();
  let count = 0;
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    try {
      await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
        version    INTEGER PRIMARY KEY,
        name       TEXT        NOT NULL,
        checksum   TEXT        NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
      const { rows } = await client.query<{ version: number; checksum: string }>(
        'SELECT version, checksum FROM schema_migrations');
      const applied = new Map(rows.map((r) => [r.version, r.checksum]));
      for (const m of migrations) {
        if (target > 0 && m.version > target) break;
        const existing = applied.get(m.version);
        if (existing !== undefined) {
          if (existing !== m.checksum) {
            throw new Error(`Migration ${pad(m.version)}_${m.name} wurde nach dem Anwenden verändert ` +
              '(Prüfsumme weicht ab) – Änderungen immer als neue Migration anlegen');
          }
          continue;
        }
        try {
          await client.query('BEGIN');
          await client.query(m.sql); // ohne Parameter: mehrere Anweisungen erlaubt
          await client.query('INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
            [m.version, m.name, m.checksum]);
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          throw new Error(`Migration ${pad(m.version)}_${m.name} fehlgeschlagen: ${(err as Error).message}`);
        }
        count++;
        log.info('Migration angewendet', { version: m.version, name: m.name });
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]).catch(() => {});
    }
  } finally {
    client.release();
  }
  log.info('Datenbankmigrationen abgeschlossen', { applied: count, schema_version: await schemaVersion(db) });
  return count;
}

export interface MigrationState {
  version: number;
  name: string;
  state: 'applied' | 'pending' | 'modified' | 'unknown';
  appliedAt: Date | null;
}

/** Vergleicht eingebettete und angewendete Migrationen (für `migrate-status`). */
export async function migrationStatus(db: Database): Promise<MigrationState[]> {
  const migrations = loadMigrations();
  const applied = new Map<number, { name: string; checksum: string; applied_at: Date }>();
  if (await tableExists(db)) {
    const { rows } = await db.query<{ version: number; name: string; checksum: string; applied_at: Date }>(
      'SELECT version, name, checksum, applied_at FROM schema_migrations');
    for (const r of rows) applied.set(r.version, r);
  }
  const out: MigrationState[] = migrations.map((m) => {
    const a = applied.get(m.version);
    if (!a) return { version: m.version, name: m.name, state: 'pending', appliedAt: null };
    return { version: m.version, name: m.name, state: a.checksum === m.checksum ? 'applied' : 'modified', appliedAt: a.applied_at };
  });
  for (const [v, a] of applied) {
    if (!migrations.some((m) => m.version === v)) out.push({ version: v, name: a.name, state: 'unknown', appliedAt: a.applied_at });
  }
  return out.sort((a, b) => a.version - b.version);
}

/** Höchste angewendete Migrationsversion (0 = keine). */
export async function schemaVersion(db: Database): Promise<number> {
  if (!(await tableExists(db))) return 0;
  const { rows } = await db.query<{ v: number }>('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations');
  return rows[0].v;
}

async function tableExists(db: Database): Promise<boolean> {
  const { rows } = await db.query<{ ok: boolean }>("SELECT to_regclass('schema_migrations') IS NOT NULL AS ok");
  return rows[0].ok;
}

const pad = (v: number) => String(v).padStart(4, '0');
