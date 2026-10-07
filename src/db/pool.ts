// PostgreSQL-Zugriff über node-postgres (pg) mit Connection-Pool.
//
// Alle Werte werden ausschließlich als Parameter ($1, $2, …) gebunden – Benutzereingaben werden nie
// in SQL-Strings eingesetzt (Schutz vor SQL-Injection).

import { readFileSync } from 'node:fs';
import pg from 'pg';
import type { Config } from '../config/config.ts';

// Typumwandlungen: DATE bleibt ein reiner Kalendertag (kein Date-Objekt in Serverzeitzone),
// BIGINT (Änderungsnummern, count) wird als Zahl geliefert (Werte bleiben weit unter 2^53).
pg.types.setTypeParser(pg.types.builtins.DATE, (v: string) => v);
pg.types.setTypeParser(pg.types.builtins.INT8, (v: string) => Number(v));

export type Queryable = Pick<pg.PoolClient, 'query'>;

export class Database {
  readonly pool: pg.Pool;
  private closed = false;

  constructor(pool: pg.Pool) {
    this.pool = pool;
  }

  static create(cfg: Config['database'], onError: (err: Error) => void): Database {
    const ssl = cfg.ssl.mode === 'disable' ? false
      : cfg.ssl.mode === 'require' ? { rejectUnauthorized: false }
        : { rejectUnauthorized: true, ca: cfg.ssl.caFile ? readFileSync(cfg.ssl.caFile, 'utf8') : undefined };
    const pool = new pg.Pool({
      host: cfg.host,
      port: cfg.port,
      database: cfg.name,
      user: cfg.user,
      password: cfg.password,
      ssl,
      max: cfg.maxConns,
      min: cfg.minConns,
      connectionTimeoutMillis: cfg.connectTimeoutMs,
      idleTimeoutMillis: 300_000,
      maxLifetimeSeconds: 1800,
      application_name: 'berichtly-server',
      options: '-c timezone=UTC',
    });
    // Fehler auf ungenutzten Verbindungen (z. B. Datenbank-Neustart) dürfen den Prozess nicht beenden;
    // der Pool ersetzt die Verbindung beim nächsten Zugriff.
    pool.on('error', onError);
    return new Database(pool);
  }

  query<R extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, params: unknown[] = []) {
    return this.pool.query<R>(sql, params);
  }

  /** Führt fn in genau einer Transaktion aus (READ COMMITTED). Fehler führen zum Rollback. */
  tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    return this.run('BEGIN ISOLATION LEVEL READ COMMITTED', fn);
  }

  /**
   * Lesende Transaktion mit genau einem konsistenten Snapshot (REPEATABLE READ). Nötig, wenn mehrere
   * Abfragen zusammen ein widerspruchsfreies Bild ergeben müssen (Synchronisations-Abruf).
   */
  snapshot<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    return this.run('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', fn);
  }

  private async run<T>(begin: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let broken = false;
    try {
      await client.query(begin);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        broken = true; // Verbindung unbrauchbar → nicht in den Pool zurückgeben
      }
      throw err;
    } finally {
      client.release(broken);
    }
  }

  async ping(timeoutMs = 3000): Promise<boolean> {
    try {
      await withTimeout(this.pool.query('SELECT 1'), timeoutMs);
      return true;
    } catch {
      return false;
    }
  }

  /** Schließt alle Verbindungen (beim kontrollierten Shutdown). */
  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.pool.end();
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), ms);
    }),
  ]);
}

/**
 * Sperrt die Benutzerzeile bis zum Ende der Transaktion. Alle Schreibvorgänge eines Kontos werden
 * dadurch serialisiert und Änderungsnummern in Commit-Reihenfolge vergeben (docs/SYNC.md).
 */
export async function lockUser(c: Queryable, userId: string) {
  await c.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);
}

export const isUniqueViolation = (err: unknown) => (err as { code?: string })?.code === '23505';
