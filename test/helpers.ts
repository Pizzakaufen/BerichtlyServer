// Integrationstests gegen eine echte PostgreSQL-Datenbank (keine Mocks). Die Tests laufen über echtes HTTP
// durch alle Schichten (Hooks, Rate Limits, Auth, Services) bis in die Datenbank.
//
// Voraussetzung: BERICHTLY_TEST_DATABASE_URL zeigt auf eine Testdatenbank, deren Name "test" enthält
// (Schutz vor versehentlichem Löschen echter Daten), z. B.
//   postgres://berichtly:passwort@127.0.0.1:5432/berichtly_test
// Ohne die Variable werden die Integrationstests übersprungen.

import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { after, afterEach } from 'node:test';
import pg from 'pg';
import { App } from '../src/app.ts';
import { type Config, loadConfig } from '../src/config/config.ts';
import { migrate } from '../src/db/migrate.ts';
import { Database } from '../src/db/pool.ts';
import type { Server } from '../src/http/server.ts';
import { createLogger, silentLogger } from '../src/util/logger.ts';

export const DB_URL = process.env.BERICHTLY_TEST_DATABASE_URL ?? '';
/** Für describe/test: { skip } wenn keine Testdatenbank konfiguriert ist. */
export const needsDb = { skip: DB_URL ? false : 'BERICHTLY_TEST_DATABASE_URL nicht gesetzt' } as const;

export const STATUS_TOKEN = 'test-status-token-0123456789abcdefghij';
export const DEFAULT_PASSWORD = 'korrekt-Pferd-Batterie-42';
const JWT_SECRET = randomBytes(48).toString('base64');

function dbParts() {
  const u = new URL(DB_URL);
  if (!u.pathname.includes('test')) throw new Error("BERICHTLY_TEST_DATABASE_URL muss auf eine Datenbank zeigen, deren Name 'test' enthält.");
  return {
    host: u.hostname, port: u.port || '5432', name: u.pathname.slice(1), user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password), sslmode: u.searchParams.get('sslmode') ?? 'disable',
  };
}

export function testEnv(overrides: Record<string, string> = {}): Record<string, string> {
  const p = dbParts();
  return {
    APP_ENV: 'test',
    DB_HOST: p.host,
    DB_PORT: p.port,
    DB_NAME: p.name,
    DB_USER: p.user,
    DB_PASSWORD: p.password,
    DB_SSLMODE: p.sslmode,
    DB_POOL_MAX_SIZE: '5',
    DB_MIGRATE_ON_START: 'false',
    JWT_SECRET,
    RATE_LIMIT_AUTH_PER_MINUTE: '10000',
    RATE_LIMIT_API_PER_MINUTE: '100000',
    RATE_LIMIT_LOGIN_PER_ACCOUNT_PER_MINUTE: '10000',
    MAINTENANCE_INTERVAL_HOURS: '0',
    LOGIN_MAX_FAILED_ATTEMPTS: '5',
    INTERNAL_STATUS_TOKEN: STATUS_TOKEN,
    API_DOCS_ENABLED: 'true',
    LOG_LEVEL: 'error',
    ...overrides,
  };
}

export const testConfig = (overrides: Record<string, string> = {}): Config => loadConfig(testEnv(overrides));

/** Direkter Datenbankzugriff für Prüfungen und Testvorbereitung. */
export function rawClient(database?: string) {
  const p = dbParts();
  return new pg.Client({ host: p.host, port: Number(p.port), database: database ?? p.name, user: p.user, password: p.password });
}

let schemaReady: Promise<void> | null = null;

/** Leert die Testdatenbank einmal pro Testprozess vollständig und führt die echten Migrationen aus. */
export function resetSchema(): Promise<void> {
  schemaReady ??= (async () => {
    const c = rawClient();
    await c.connect();
    await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await c.end();
    const db = Database.create(testConfig().database, () => {});
    await migrate(db, silentLogger());
    await db.close();
  })();
  return schemaReady;
}

// ---------------------------------------------------------------------------
// Laufende Testinstanz
// ---------------------------------------------------------------------------

export interface EnvOptions {
  overrides?: Record<string, string>;
  now?: () => Date;
  /** Bestehende Daten behalten (eigene Datenbank, z. B. Upgrade-Test). */
  keepData?: boolean;
  /** Instanz für mehrere Tests (in before() erzeugt); wird erst am Ende der Datei geschlossen. */
  shared?: boolean;
  /** Log-Zeilen des Servers (JSON) sammeln, statt sie zu verwerfen. */
  logLines?: string[];
  /** Header, die jede Anfrage mitsendet (z. B. X-Forwarded-For). */
  headers?: Record<string, string>;
}

export interface Session {
  access: string;
  refresh: string;
  userId: string;
  sessionId: string;
}

export class Res {
  readonly status: number;
  readonly headers: Headers;
  readonly raw: string;
  readonly body: any;

  constructor(status: number, headers: Headers, raw: string) {
    this.status = status;
    this.headers = headers;
    this.raw = raw;
    this.body = raw && (headers.get('content-type') ?? '').startsWith('application/json') ? JSON.parse(raw) : undefined;
  }

  expect(status: number): this {
    assert.equal(this.status, status, `HTTP ${status} erwartet, ${this.status} erhalten: ${this.raw}`);
    return this;
  }

  get data(): any {
    return this.body?.data;
  }

  get code(): string {
    return this.body?.error?.code;
  }

  get fields(): string[] {
    return (this.body?.error?.details ?? []).map((d: { field: string }) => d.field);
  }

  get issues(): Record<string, string> {
    return Object.fromEntries((this.body?.error?.details ?? []).map((d: { field: string; issue: string }) => [d.field, d.issue]));
  }

  session(): Session {
    const d = this.data;
    return { access: d.tokens.accessToken, refresh: d.tokens.refreshToken, userId: d.account.id, sessionId: d.tokens.sessionId };
  }
}

export class Env {
  readonly app: App;
  readonly server: Server;
  readonly base: string;
  private readonly headers: Record<string, string>;

  private constructor(app: App, server: Server, base: string, headers: Record<string, string>) {
    this.app = app;
    this.server = server;
    this.base = base;
    this.headers = headers;
  }

  static async create(o: EnvOptions = {}): Promise<Env> {
    if (!o.keepData) await resetSchema();
    const lines = o.logLines;
    const log = lines ? createLogger('info', 'json', (l) => lines.push(l)) : silentLogger();
    const app = new App(testConfig(o.overrides), log, o.now ?? (() => new Date()));
    if (!o.keepData) await app.db.query('TRUNCATE users, security_events, server_state CASCADE');
    const server = await app.buildServer();
    await server.app.listen({ host: '127.0.0.1', port: 0 });
    const port = (server.app.server.address() as AddressInfo).port;
    const env = new Env(app, server, `http://127.0.0.1:${port}`, o.headers ?? {});
    (o.shared ? sharedEnvs : testEnvs).add(env);
    return env;
  }

  async close() {
    await this.server.close(5000);
    await this.app.close();
  }

  get db() {
    return this.app.db;
  }

  async request(method: string, path: string, token = '', body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
    const h: Record<string, string> = { ...this.headers };
    let payload: string | undefined;
    if (body !== undefined) {
      payload = typeof body === 'string' ? body : JSON.stringify(body);
      h['Content-Type'] = 'application/json';
    }
    if (token) h.Authorization = `Bearer ${token}`;
    Object.assign(h, headers);
    const res = await fetch(this.base + path, { method, headers: h, body: payload });
    return new Res(res.status, res.headers, await res.text());
  }

  get(path: string, token = '', headers: Record<string, string> = {}) {
    return this.request('GET', path, token, undefined, headers);
  }

  post(path: string, token = '', body?: unknown) {
    return this.request('POST', path, token, body);
  }

  put(path: string, token = '', body?: unknown) {
    return this.request('PUT', path, token, body);
  }

  patch(path: string, token = '', body?: unknown) {
    return this.request('PATCH', path, token, body);
  }

  delete(path: string, token = '') {
    return this.request('DELETE', path, token);
  }

  async register(email = '', extra: Record<string, unknown> = {}): Promise<Session> {
    const e = email || `user-${randomUUID()}@example.org`;
    return (await this.post('/api/v1/auth/register', '', { email: e, password: DEFAULT_PASSWORD, ...extra })).expect(201).session();
  }

  login(email: string, password: string) {
    return this.post('/api/v1/auth/login', '', { email, password });
  }

  /**
   * Verschiebt einen Zeitstempel in die Vergangenheit, ohne den Änderungs-Trigger auszulösen (sonst bekäme
   * die Zeile eine neue Änderungsnummer – im echten Betrieb werden gelöschte Datensätze nie mehr verändert).
   * Tabellen-, Spalten- und Intervallwerte stammen ausschließlich aus dem Testcode.
   */
  async ageRow(table: string, column: string, interval: string, id: string) {
    await this.db.tx(async (c) => {
      await c.query(`ALTER TABLE ${table} DISABLE TRIGGER ${table}_touch`);
      await c.query(`UPDATE ${table} SET ${column} = now() - $1::interval WHERE id = $2`, [interval, id]);
      await c.query(`ALTER TABLE ${table} ENABLE TRIGGER ${table}_touch`);
    });
  }
}

// Aufräumen: Instanzen eines Tests nach dem Test, geteilte am Ende der Datei.
const testEnvs = new Set<Env>();
const sharedEnvs = new Set<Env>();
const closeAll = async (set: Set<Env>) => {
  const envs = [...set];
  set.clear();
  await Promise.all(envs.map((e) => e.close()));
};
afterEach(() => closeAll(testEnvs));
after(async () => {
  await closeAll(testEnvs);
  await closeAll(sharedEnvs);
});

export const newEnv = (o?: EnvOptions) => Env.create(o);
export const uuid = () => randomUUID();

// ---------------------------------------------------------------------------
// Testdaten
// ---------------------------------------------------------------------------

export const daily = (date: string, text: string, status = 'DRAFT') => ({ date, text, note: '', orderIndex: 0, status });

export function dailyChange(id: string, text: string, base: number | null, op: 'UPSERT' | 'DELETE') {
  const c: Record<string, unknown> = { type: 'DAILY_REPORT', operation: op, id, baseVersion: base };
  if (op === 'UPSERT') c.data = { date: '2026-10-05', text };
  return c;
}

export const push = (...changes: Record<string, unknown>[]) => ({ changes });

export const statuses = (r: Res): string[] => r.data.results.map((x: { status: string }) => x.status);

/**
 * Legt eine eigene, leere Datenbank für einen Test an (für Upgrade- und Leistungstests) und liefert die
 * Konfigurationsüberschreibungen dafür. Ohne CREATEDB-Recht wird null geliefert (Test überspringen).
 */
export async function tempDatabase(): Promise<{ overrides: Record<string, string>; drop: () => Promise<void> } | null> {
  const name = `berichtly_upgrade_test_${randomUUID().slice(0, 8)}`;
  const admin = rawClient();
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name}`); // Name stammt ausschließlich aus [a-z0-9_]
  } catch {
    return null;
  } finally {
    await admin.end();
  }
  return {
    overrides: { DB_NAME: name },
    async drop() {
      const c = rawClient();
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await c.end();
    },
  };
}

/** Testinstanz auf einer bestimmten (bereits migrierten) Datenbank, ohne die Daten zu leeren. */
export async function envOn(overrides: Record<string, string>): Promise<Env> {
  return Env.create({ overrides, keepData: true });
}
