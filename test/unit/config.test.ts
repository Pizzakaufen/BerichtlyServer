import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { loadConfig, mergeEnvFile, summary } from '../../src/config/config.ts';

const SECRET = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyzABCDEF').toString('base64');
const base = (): Record<string, string | undefined> => ({ APP_ENV: 'test', DB_USER: 'berichtly', DB_PASSWORD: 'geheim', JWT_SECRET: SECRET });
const withEnv = (kv: Record<string, string | undefined>) => ({ ...base(), ...kv });

test('fehlende oder schwache Secrets verhindern den Start', () => {
  for (const env of [
    withEnv({ JWT_SECRET: undefined }),
    withEnv({ JWT_SECRET: 'zu-kurz' }),
    withEnv({ JWT_SECRET: Buffer.from('A'.repeat(64)).toString('base64') }),
    withEnv({ DB_PASSWORD: undefined }),
    withEnv({ INTERNAL_STATUS_TOKEN: 'kurz' }),
  ]) {
    assert.throws(() => loadConfig(env), `Konfiguration hätte abgelehnt werden müssen: ${JSON.stringify(env)}`);
  }
});

test('Produktion ist der Standard und sicher voreingestellt', () => {
  assert.throws(() => loadConfig(withEnv({ APP_ENV: 'production', CORS_ALLOWED_ORIGINS: '*' })), 'CORS-Wildcard in Produktion');
  const c = loadConfig(withEnv({ APP_ENV: undefined }));
  assert.equal(c.env, 'production');
  assert.equal(c.apiDocs, false);
  assert.equal(c.log.level, 'info');
  assert.equal(c.log.format, 'json');
  assert.equal(c.server.host, '127.0.0.1'); // Node.js nie direkt öffentlich – nur über Nginx
  assert.equal(c.server.port, 3000);
  assert.equal(c.server.trustProxy, false);
  assert.equal(c.auth.accessTokenTtlSec, 15 * 60);
  assert.equal(c.server.maxBodyBytes, 1024 * 1024);
  assert.ok(!summary(c).includes('geheim') && !c.database.display.includes('geheim'), 'Secrets in der Ausgabe');
});

test('ungültige Werte', () => {
  for (const kv of [
    { SERVER_PORT: '99999' }, { APP_ENV: 'staging' }, { DEFAULT_TIMEZONE: 'Berlin' }, { CORS_ALLOWED_ORIGINS: 'app.example.de' },
    { ACCESS_TOKEN_TTL_MINUTES: '1440' }, { DB_SSLMODE: 'egal' }, { DB_HOST: 'host;drop' }, { TRUST_PROXY: 'vielleicht' },
    { SERVER_PORT: '30x' },
  ]) {
    assert.throws(() => loadConfig(withEnv(kv)), JSON.stringify(kv));
  }
});

test('Aufbewahrung und Rate Limits konfigurierbar', () => {
  let c = loadConfig(base());
  assert.equal(c.retention.tombstonesSec, 365 * 86400);
  assert.equal(c.retention.operationsSec, 30 * 86400);
  assert.equal(c.maintenanceIntervalMs, 24 * 3600_000);
  assert.deepEqual([c.rateLimit.loginPerMinute, c.rateLimit.registerPerMinute, c.rateLimit.refreshPerMinute,
    c.rateLimit.loginPerAccountPerMinute], [10, 5, 30, 5]);
  // Kompatibilität mit 1.0: RATE_LIMIT_AUTH_PER_MINUTE gilt weiterhin für alle Auth-Endpunkte.
  c = loadConfig(withEnv({ RATE_LIMIT_AUTH_PER_MINUTE: '20' }));
  assert.deepEqual([c.rateLimit.loginPerMinute, c.rateLimit.registerPerMinute, c.rateLimit.refreshPerMinute], [20, 20, 20]);
  for (const kv of [{ TOMBSTONE_RETENTION_DAYS: '7' }, { MAINTENANCE_INTERVAL_HOURS: '-1' }, { SYNC_OPERATION_RETENTION_DAYS: '0' }]) {
    assert.throws(() => loadConfig(withEnv(kv)), JSON.stringify(kv));
  }
  assert.equal(loadConfig(withEnv({ MAINTENANCE_INTERVAL_HOURS: '0' })).maintenanceIntervalMs, 0);
});

test('Datenbank-TLS-Modi', () => {
  assert.equal(loadConfig(withEnv({ DB_SSLMODE: 'require' })).database.ssl.mode, 'require');
  assert.equal(loadConfig(withEnv({ DB_SSLMODE: 'verify-full' })).database.ssl.mode, 'verify-full');
  assert.equal(loadConfig(withEnv({ DB_SSLMODE: 'disable' })).database.ssl.mode, 'disable');
});

// Jede gelesene Umgebungsvariable muss in .env.example dokumentiert sein, und die Beispieldatei muss (mit
// eingesetzten Secrets) eine gültige Konfiguration ergeben.
test('.env.example vollständig und gültig', () => {
  const src = readFileSync(new URL('../../src/config/config.ts', import.meta.url), 'utf8');
  const example = readFileSync(new URL('../../.env.example', import.meta.url), 'utf8');
  const keys = [...src.matchAll(/r\.(?:str|int|bool|required|secret|optional)\('([A-Z_]+)'/g)].map((m) => m[1]);
  assert.ok(keys.length >= 40, `nur ${keys.length} Variablen gefunden`);
  // Nginx-/Compose-Variablen werden nicht vom Server gelesen, gehören aber ebenfalls in die Beispieldatei.
  for (const k of [...new Set(keys), 'BERICHTLY_DOMAIN', 'NGINX_HTTP_PORT', 'NGINX_HTTPS_PORT', 'NGINX_CONFIG', 'TLS_DIR']) {
    assert.match(example, new RegExp(`^#? ?${k}=`, 'm'), `${k} ist nicht in .env.example dokumentiert`);
  }
  const env = mergeEnvFile(fileURLToPath(new URL('../../.env.example', import.meta.url)), { DB_PASSWORD: 'beispiel', JWT_SECRET: SECRET });
  assert.doesNotThrow(() => loadConfig(env), '.env.example ergibt keine gültige Konfiguration');
  // Die Beispieldatei enthält keine echten Secrets.
  assert.match(example, /^JWT_SECRET=$/m);
  assert.match(example, /^DB_PASSWORD=$/m);
});
