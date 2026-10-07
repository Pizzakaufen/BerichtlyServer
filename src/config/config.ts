// Konfiguration ausschließlich aus Umgebungsvariablen (optional ergänzt um eine .env-Datei).
// Secrets haben bewusst keine Standardwerte: Fehlen sie, startet der Server nicht.
// Die Variablen sind identisch mit Berichtly Server 1.1, damit bestehende Konfigurationen weiter gelten.

import { readFileSync } from 'node:fs';

export type Environment = 'development' | 'test' | 'production';

export interface DbSsl {
  mode: 'disable' | 'require' | 'verify-full';
  caFile?: string;
}

export interface Config {
  env: Environment;
  server: {
    host: string;
    port: number;
    trustProxy: boolean; // nur hinter einem vertrauenswürdigen Reverse Proxy (Nginx)
    shutdownTimeoutMs: number;
    maxBodyBytes: number;
  };
  database: {
    host: string;
    port: number;
    name: string;
    user: string;
    password: string;
    ssl: DbSsl;
    sslModeRaw: string;
    maxConns: number;
    minConns: number;
    connectTimeoutMs: number;
    migrateOnStart: boolean;
    display: string; // ohne Passwort, für Ausgaben
  };
  auth: {
    jwtSecret: Buffer;
    issuer: string;
    audience: string;
    accessTokenTtlSec: number;
    refreshTokenTtlSec: number;
    sessionMaxLifetimeSec: number;
    registrationEnabled: boolean;
    maxFailedLogins: number;
    lockoutSec: number;
    defaultTimezone: string;
  };
  rateLimit: {
    loginPerMinute: number;
    loginPerAccountPerMinute: number;
    registerPerMinute: number;
    refreshPerMinute: number;
    apiPerMinute: number;
  };
  retention: {
    tombstonesSec: number;
    operationsSec: number;
    securityEventsSec: number;
    sessionsSec: number;
  };
  maintenanceIntervalMs: number;
  corsAllowedOrigins: string[];
  log: { level: 'debug' | 'info' | 'warn' | 'error'; format: 'text' | 'json' };
  apiDocs: boolean;
  status: { internalToken: string; minFreeDiskMb: number };
}

const DAY = 86_400;

export class ConfigError extends Error {}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const r = new Reader(env);

  const envRaw = r.str('APP_ENV', 'production').toLowerCase();
  const appEnv: Environment | null = envRaw === 'development' || envRaw === 'dev' ? 'development'
    : envRaw === 'test' ? 'test'
      : envRaw === 'production' || envRaw === 'prod' ? 'production' : null;
  if (!appEnv) r.fail("APP_ENV muss 'development', 'test' oder 'production' sein");
  const prod = appEnv === 'production';

  const server = {
    // Node.js lauscht standardmäßig nur lokal; öffentlicher Einstiegspunkt ist Nginx.
    host: r.str('SERVER_HOST', '127.0.0.1'),
    port: r.int('SERVER_PORT', 3000, 1, 65535),
    trustProxy: r.bool('TRUST_PROXY', false),
    shutdownTimeoutMs: r.int('SHUTDOWN_TIMEOUT_SECONDS', 15, 1, 300) * 1000,
    maxBodyBytes: r.int('MAX_REQUEST_BODY_BYTES', 1 << 20, 1024, 50 << 20),
  };

  const sslModeRaw = r.str('DB_SSLMODE', 'prefer');
  if (!['disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full'].includes(sslModeRaw)) {
    r.fail('DB_SSLMODE ist ungültig');
  }
  // Der Node-Treiber kennt kein opportunistisches TLS: disable/allow/prefer = unverschlüsselt
  // (nur lokal bzw. im privaten Docker-Netz sinnvoll), require = verschlüsselt ohne
  // Zertifikatsprüfung, verify-ca/verify-full = verschlüsselt mit Zertifikatsprüfung.
  const ssl: DbSsl = {
    mode: ['require'].includes(sslModeRaw) ? 'require'
      : ['verify-ca', 'verify-full'].includes(sslModeRaw) ? 'verify-full' : 'disable',
    caFile: r.optional('DB_SSL_CA_FILE'),
  };

  const database = {
    host: r.str('DB_HOST', 'localhost'),
    port: r.int('DB_PORT', 5432, 1, 65535),
    name: r.str('DB_NAME', 'berichtly'),
    user: r.required('DB_USER'),
    password: r.required('DB_PASSWORD'),
    ssl,
    sslModeRaw,
    maxConns: r.int('DB_POOL_MAX_SIZE', 10, 1, 200),
    minConns: r.int('DB_POOL_MIN_IDLE', 0, 0, 200),
    connectTimeoutMs: r.int('DB_CONNECT_TIMEOUT_SECONDS', 5, 1, 60) * 1000,
    migrateOnStart: r.bool('DB_MIGRATE_ON_START', true),
    display: '',
  };
  if (database.minConns > database.maxConns) r.fail('DB_POOL_MIN_IDLE darf nicht größer als DB_POOL_MAX_SIZE sein');
  const dbUrl = r.optional('DB_URL');
  if (dbUrl) {
    try {
      const u = new URL(dbUrl);
      if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') throw new Error();
      database.host = decodeURIComponent(u.hostname) || database.host;
      database.port = u.port ? Number(u.port) : 5432;
      database.name = decodeURIComponent(u.pathname.replace(/^\//, '')) || database.name;
      const mode = u.searchParams.get('sslmode');
      if (mode === 'require') database.ssl = { ...ssl, mode: 'require' };
      if (mode === 'verify-ca' || mode === 'verify-full') database.ssl = { ...ssl, mode: 'verify-full' };
      if (mode === 'disable' || mode === 'prefer' || mode === 'allow') database.ssl = { ...ssl, mode: 'disable' };
    } catch {
      r.fail('DB_URL muss eine postgres://-URL sein');
    }
  }
  if (!/^[A-Za-z0-9._-]+$/.test(database.host) || !/^[A-Za-z0-9_-]+$/.test(database.name)) {
    r.fail('DB_HOST oder DB_NAME enthält ungültige Zeichen');
  }
  database.display = `postgres://${database.user}@${database.host}:${database.port}/${database.name}?sslmode=${sslModeRaw}`;

  const auth = {
    jwtSecret: r.secret('JWT_SECRET'),
    issuer: r.str('JWT_ISSUER', 'berichtly-server'),
    audience: r.str('JWT_AUDIENCE', 'berichtly-app'),
    accessTokenTtlSec: r.int('ACCESS_TOKEN_TTL_MINUTES', 15, 1, 60) * 60,
    refreshTokenTtlSec: r.int('REFRESH_TOKEN_TTL_DAYS', 30, 1, 90) * DAY,
    sessionMaxLifetimeSec: r.int('SESSION_MAX_LIFETIME_DAYS', 180, 1, 365) * DAY,
    registrationEnabled: r.bool('REGISTRATION_ENABLED', true),
    maxFailedLogins: r.int('LOGIN_MAX_FAILED_ATTEMPTS', 10, 3, 100),
    lockoutSec: r.int('LOGIN_LOCKOUT_MINUTES', 15, 1, 1440) * 60,
    defaultTimezone: r.str('DEFAULT_TIMEZONE', 'Europe/Berlin'),
  };
  if (!validTimezone(auth.defaultTimezone)) r.fail('DEFAULT_TIMEZONE ist keine gültige Zeitzone (z. B. Europe/Berlin)');

  // Ist RATE_LIMIT_AUTH_PER_MINUTE (aus 1.0) gesetzt, gilt der Wert weiterhin für alle Auth-Endpunkte.
  let [loginDef, registerDef, refreshDef] = [10, 5, 30];
  if (r.optional('RATE_LIMIT_AUTH_PER_MINUTE')) {
    const a = r.int('RATE_LIMIT_AUTH_PER_MINUTE', 10, 1, 10000);
    [loginDef, registerDef, refreshDef] = [a, a, a];
  }
  const rateLimit = {
    loginPerMinute: r.int('RATE_LIMIT_LOGIN_PER_MINUTE', loginDef, 1, 10000),
    loginPerAccountPerMinute: r.int('RATE_LIMIT_LOGIN_PER_ACCOUNT_PER_MINUTE', 5, 1, 10000),
    registerPerMinute: r.int('RATE_LIMIT_REGISTER_PER_MINUTE', registerDef, 1, 10000),
    refreshPerMinute: r.int('RATE_LIMIT_REFRESH_PER_MINUTE', refreshDef, 1, 10000),
    apiPerMinute: r.int('RATE_LIMIT_API_PER_MINUTE', 300, 1, 100000),
  };

  const retention = {
    tombstonesSec: r.int('TOMBSTONE_RETENTION_DAYS', 365, 30, 3650) * DAY,
    operationsSec: r.int('SYNC_OPERATION_RETENTION_DAYS', 30, 1, 365) * DAY,
    securityEventsSec: r.int('SECURITY_EVENT_RETENTION_DAYS', 180, 7, 3650) * DAY,
    sessionsSec: r.int('SESSION_RETENTION_DAYS', 30, 1, 365) * DAY,
  };
  const maintenanceIntervalMs = r.int('MAINTENANCE_INTERVAL_HOURS', 24, 0, 168) * 3_600_000;

  const corsAllowedOrigins: string[] = [];
  for (const raw of r.str('CORS_ALLOWED_ORIGINS', '').split(',')) {
    const o = raw.trim();
    if (!o) continue;
    if (o === '*') {
      if (prod) r.fail("CORS_ALLOWED_ORIGINS darf in Produktion nicht '*' enthalten");
    } else if (!/^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/.test(o)) {
      r.fail(`ungültige Origin in CORS_ALLOWED_ORIGINS: "${o}" (erwartet z. B. https://app.example.de)`);
    }
    corsAllowedOrigins.push(o);
  }

  const level = r.str('LOG_LEVEL', prod ? 'info' : 'debug').toLowerCase();
  if (!['debug', 'info', 'warn', 'error'].includes(level)) r.fail('LOG_LEVEL muss debug, info, warn oder error sein');
  const format = r.str('LOG_FORMAT', prod ? 'json' : 'text').toLowerCase();
  if (!['text', 'json'].includes(format)) r.fail("LOG_FORMAT muss 'text' oder 'json' sein");

  const internalToken = r.str('INTERNAL_STATUS_TOKEN', '');
  if (internalToken && internalToken.length < 32) r.fail('INTERNAL_STATUS_TOKEN muss mindestens 32 Zeichen lang sein');

  const config: Config = {
    env: appEnv ?? 'production',
    server, database, auth, rateLimit, retention, maintenanceIntervalMs, corsAllowedOrigins,
    log: { level: level as Config['log']['level'], format: format as Config['log']['format'] },
    apiDocs: r.bool('API_DOCS_ENABLED', !prod),
    status: { internalToken, minFreeDiskMb: r.int('STATUS_MIN_FREE_DISK_MB', 512, 0, 10_000_000) },
  };
  if (r.errors.length > 0) throw new ConfigError(`Konfigurationsfehler:\n  - ${r.errors.join('\n  - ')}`);
  return config;
}

/** Konfiguration ohne Secrets (für `check-config`). */
export function summary(c: Config): string {
  const days = (s: number) => `${Math.round(s / DAY)} Tage`;
  return [
    `Umgebung:   ${c.env}`,
    `Server:     ${c.server.host}:${c.server.port} (trustProxy=${c.server.trustProxy}, maxBody=${c.server.maxBodyBytes} Byte)`,
    `Datenbank:  ${c.database.display} (TLS: ${c.database.ssl.mode}, Pool max=${c.database.maxConns}, min=${c.database.minConns}, migrateOnStart=${c.database.migrateOnStart})`,
    `Auth:       Access Token ${c.auth.accessTokenTtlSec / 60} min, Refresh Token ${days(c.auth.refreshTokenTtlSec)}, Sitzung max. ${days(c.auth.sessionMaxLifetimeSec)}, Registrierung=${c.auth.registrationEnabled}, JWT_SECRET=***`,
    `Rate Limit: Login ${c.rateLimit.loginPerMinute}/min (pro Konto ${c.rateLimit.loginPerAccountPerMinute}/min), Registrierung ${c.rateLimit.registerPerMinute}/min, Refresh ${c.rateLimit.refreshPerMinute}/min, API ${c.rateLimit.apiPerMinute}/min pro IP`,
    `Aufbewahrung: Tombstones ${days(c.retention.tombstonesSec)}, Sync-Operationen ${days(c.retention.operationsSec)}, Sicherheitsereignisse ${days(c.retention.securityEventsSec)}, alte Sitzungen ${days(c.retention.sessionsSec)}`,
    `Wartung:    ${c.maintenanceIntervalMs > 0 ? `automatisch alle ${c.maintenanceIntervalMs / 3_600_000} h` : 'nur per CLI (berichtly-server maintenance)'}`,
    `CORS:       ${c.corsAllowedOrigins.length ? c.corsAllowedOrigins.join(', ') : '<deaktiviert>'}`,
    `Logging:    ${c.log.level} / ${c.log.format}`,
    `API-Doku:   ${c.apiDocs ? 'aktiviert (/api/docs)' : 'deaktiviert'}`,
    `Status:     ${c.status.internalToken ? 'aktiviert (Token gesetzt)' : '<deaktiviert>'}`,
  ].join('\n');
}

/** Liest eine einfache .env-Datei (KEY=VALUE, # Kommentare). Echte Umgebungsvariablen haben Vorrang. */
export function mergeEnvFile(path: string, env: Record<string, string | undefined>): Record<string, string | undefined> {
  let content: string;
  try {
    content = readFileSync(path, 'utf8');
  } catch (e) {
    throw new ConfigError(`Konfigurationsdatei kann nicht gelesen werden: ${(e as Error).message}`);
  }
  const merged: Record<string, string | undefined> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).replace(/^export\s+/, '').trim();
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && ((value[0] === '"' && value.endsWith('"')) || (value[0] === "'" && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    if (key) merged[key] = value;
  }
  for (const [k, v] of Object.entries(env)) if (v !== undefined) merged[k] = v;
  return merged;
}

function validTimezone(tz: string): boolean {
  if (!tz.includes('/')) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

class Reader {
  readonly errors: string[] = [];
  private readonly env: Record<string, string | undefined>;

  constructor(env: Record<string, string | undefined>) {
    this.env = env;
  }

  fail(msg: string) {
    this.errors.push(msg);
  }

  optional(key: string): string | undefined {
    const v = this.env[key]?.trim();
    return v ? v : undefined;
  }

  str(key: string, def: string): string {
    return this.optional(key) ?? def;
  }

  required(key: string): string {
    const v = this.optional(key);
    if (!v) this.fail(`Umgebungsvariable ${key} fehlt`);
    return v ?? '';
  }

  int(key: string, def: number, min: number, max: number): number {
    const raw = this.optional(key);
    if (raw === undefined) return def;
    if (!/^-?\d+$/.test(raw)) {
      this.fail(`${key} muss eine ganze Zahl sein`);
      return def;
    }
    const v = Number(raw);
    if (v < min || v > max) {
      this.fail(`${key} muss zwischen ${min} und ${max} liegen`);
      return def;
    }
    return v;
  }

  bool(key: string, def: boolean): boolean {
    const raw = this.optional(key)?.toLowerCase();
    if (raw === undefined) return def;
    if (['true', '1', 'yes'].includes(raw)) return true;
    if (['false', '0', 'no'].includes(raw)) return false;
    this.fail(`${key} muss 'true' oder 'false' sein`);
    return def;
  }

  secret(key: string): Buffer {
    const raw = this.required(key);
    if (!raw) return Buffer.alloc(0);
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw) || raw.length % 4 !== 0) {
      this.fail(`${key} muss Base64-kodiert sein (z. B. 'openssl rand -base64 48')`);
      return Buffer.alloc(0);
    }
    const b = Buffer.from(raw, 'base64');
    if (b.length < 32) {
      this.fail(`${key} muss mindestens 32 Byte Zufallsdaten enthalten`);
      return Buffer.alloc(0);
    }
    if (new Set(b).size < 8) {
      this.fail(`${key} ist offensichtlich nicht zufällig`);
      return Buffer.alloc(0);
    }
    return b;
  }
}
