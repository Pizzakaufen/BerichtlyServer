// Berichtly Server – Backend für die Berichtly-Android-App (Node.js).
// Einstiegspunkt für Server und Verwaltungsbefehle: node src/cli.ts [--env-file <pfad>] <befehl>

import { App, VERSION } from './app.ts';
import { type Config, ConfigError, loadConfig, mergeEnvFile, summary } from './config/config.ts';
import { latestSchemaVersion, migrate, migrationStatus, schemaVersion } from './db/migrate.ts';
import { invalidateSyncCursors } from './db/repositories/maintenance.ts';
import { audit, insertBackupRun, listAdmins, listBackups, setRoleByEmail } from './db/repositories/admin.ts';
import { connectUri, DEFAULT_TLS_CERT, tlsInfoFromFile } from './security/tls.ts';
import { createLogger } from './util/logger.ts';

const USAGE = `Berichtly Server – Backend für die Berichtly-Android-App

Verwendung: berichtly-server [--env-file <pfad>] <befehl>

Befehle:
  serve          Server starten (Standard). Beenden mit SIGTERM/Strg+C (kontrollierter Shutdown).
  migrate        Datenbankmigrationen ausführen und beenden.
  migrate-status Stand der Datenbankmigrationen anzeigen (angewendet, ausstehend, verändert).
  db-check       Datenbankverbindung und Schema-Version prüfen (Exit-Code 0 = in Ordnung).
  maintenance    Wartung jetzt ausführen: abgelaufene Tombstones, Sync-Operationen,
                 Sicherheitsereignisse und Sitzungen gemäß Aufbewahrungsfristen entfernen.
  reset-sync-cursors
                 Nach dem Einspielen eines Backups: alle Sync-Cursor ungültig machen, damit
                 jedes Gerät einmal vollständig neu synchronisiert.
  check-config   Konfiguration prüfen (ohne Secrets auszugeben) und beenden.
  healthcheck    Readiness des laufenden Servers abfragen (Exit-Code 0 = bereit).
  seed-dev       Entwicklungskonto mit Beispieldaten anlegen (nur APP_ENV=development).
  admin grant <E-Mail> | admin revoke <E-Mail> | admin list
                 Administratorrechte für das Admin-Dashboard vergeben, entziehen bzw. anzeigen (seit 2.0).
                 Rechte gibt es nur über diese Befehle, nie über die API.
  backup-record --file <name> --started <ISO-Zeit> --result SUCCESS|FAILED [--size <Byte>] [--sha256 <hex>]
                [--verified true|false] [--verification <text>] [--error <text>]
                 Ergebnis eines Backups protokollieren (wird von deploy/backup.sh aufgerufen, seit 2.0).
  backups        Die letzten Backups anzeigen.
  tls-pin [--cert <datei>] [--address <ip>] [--uri]
                 Fingerabdruck (Pin) des eigenen TLS-Zertifikats für die App anzeigen (Betrieb ohne
                 Domain). --uri gibt nur die Verbindungsdaten für die App bzw. den QR-Code aus.
  version        Version anzeigen.
  help           Diese Hilfe anzeigen.

Die Konfiguration erfolgt über Umgebungsvariablen (siehe .env.example).
`;

function fail(code: number, msg: string): never {
  process.stderr.write(msg + '\n');
  process.exit(code);
}

function loadEnv(envFile: string | null): Record<string, string | undefined> {
  const env = { ...process.env };
  if (!envFile) return env;
  try {
    return mergeEnvFile(envFile, env);
  } catch (e) {
    fail(2, (e as Error).message);
  }
}

function config(envFile: string | null): Config {
  try {
    return loadConfig(loadEnv(envFile));
  } catch (e) {
    if (e instanceof ConfigError) fail(2, e.message);
    throw e;
  }
}

function newApp(cfg: Config): App {
  return new App(cfg, createLogger(cfg.log.level, cfg.log.format));
}

async function main(argv: string[]) {
  let args = argv;
  let envFile: string | null = null;
  if (args[0] === '--env-file') {
    if (args.length < 2) fail(2, '--env-file benötigt einen Pfad');
    envFile = args[1];
    args = args.slice(2);
  }
  const cmd = args[0] ?? 'serve';

  switch (cmd) {
    case 'help': case '-h': case '--help':
      process.stdout.write(USAGE);
      return;
    case 'version': case '--version':
      console.log(`Berichtly Server ${VERSION}`);
      return;
    case 'tls-pin':
      return tlsPin(args.slice(1));
    case 'healthcheck':
      return healthcheck(loadEnv(envFile));
    case 'check-config': {
      const cfg = config(envFile);
      console.log('Konfiguration gültig.');
      console.log(summary(cfg));
      return;
    }
    case 'migrate': {
      const a = newApp(config(envFile));
      try {
        await migrate(a.db, a.log);
      } catch (e) {
        a.log.error('Migration fehlgeschlagen', { error: (e as Error).message });
        await a.close();
        process.exit(1);
      }
      await a.close();
      return;
    }
    case 'migrate-status':
      return migrateStatusCmd(config(envFile));
    case 'db-check':
      return dbCheck(config(envFile));
    case 'maintenance': {
      const a = newApp(config(envFile));
      let res;
      try {
        res = await a.runMaintenance();
      } catch (e) {
        await a.close();
        fail(1, 'Wartung fehlgeschlagen: ' + (e as Error).message);
      }
      await a.close();
      if (res.skipped) {
        console.log('Wartung übersprungen: Ein anderer Wartungslauf ist gerade aktiv.');
        return;
      }
      console.log(`Wartung abgeschlossen:
  Tombstones entfernt:          ${res.tombstonesPurged}
  Gültige Sync-Cursor ab:       ${res.minValidCursor}
  Sync-Operationen entfernt:    ${res.operationsPurged}
  Sicherheitsereignisse entf.:  ${res.securityEventsPurged}
  Sitzungen entfernt:           ${res.sessionsPurged}
  Refresh Tokens entfernt:      ${res.refreshTokensPurged}`);
      return;
    }
    case 'reset-sync-cursors': {
      const a = newApp(config(envFile));
      try {
        await invalidateSyncCursors(a.db);
      } catch (e) {
        await a.close();
        fail(1, 'Zurücksetzen fehlgeschlagen: ' + (e as Error).message);
      }
      await a.close();
      a.log.warn('Alle Sync-Cursor wurden ungültig gemacht – Geräte synchronisieren beim nächsten Mal vollständig neu');
      console.log('Sync-Cursor zurückgesetzt. Alle Geräte erhalten beim nächsten Abruf SYNC_CURSOR_EXPIRED und synchronisieren vollständig neu.');
      return;
    }
    case 'seed-dev': {
      const cfg = config(envFile);
      if (cfg.env !== 'development') fail(1, 'seed-dev ist nur mit APP_ENV=development erlaubt');
      const a = newApp(cfg);
      try {
        await migrate(a.db, a.log);
        const { email, password } = await a.seedDev();
        console.log(`Entwicklungskonto angelegt:\n  E-Mail:   ${email}\n  Passwort: ${password}\n(Das Passwort wird nicht gespeichert und nur jetzt angezeigt.)`);
      } catch (e) {
        await a.close();
        fail(1, (e as Error).message);
      }
      await a.close();
      return;
    }
    case 'admin':
      return adminCmd(config(envFile), args.slice(1));
    case 'backup-record':
      return backupRecord(config(envFile), args.slice(1));
    case 'backups':
      return backupsCmd(config(envFile));
    case 'serve':
      return serve(config(envFile));
    default:
      fail(2, `Unbekannter Befehl: ${cmd}\n\n${USAGE}`);
  }
}

async function serve(cfg: Config) {
  const a = newApp(cfg);
  const log = a.log;
  log.info('Starte Berichtly Server', { version: VERSION, environment: cfg.env, node: process.version });

  if (cfg.database.migrateOnStart) {
    try {
      await migrate(a.db, log);
    } catch (e) {
      log.error('Datenbankmigration beim Start fehlgeschlagen – Server wird nicht gestartet', { error: (e as Error).message });
      await a.close();
      process.exit(1);
    }
  }
  try {
    const v = await schemaVersion(a.db);
    if (v < latestSchemaVersion()) {
      log.error("Datenbankschema ist veraltet – bitte zuerst 'berichtly-server migrate' ausführen",
        { schema_version: v, required: latestSchemaVersion() });
      await a.close();
      process.exit(1);
    } else if (v > latestSchemaVersion()) {
      log.warn('Datenbankschema ist neuer als diese Programmversion (Downgrade?)', { schema_version: v, known: latestSchemaVersion() });
    }
  } catch (e) {
    log.warn('Schema-Version konnte nicht geprüft werden (Datenbank nicht erreichbar?)', { error: (e as Error).message });
  }

  const server = await a.buildServer();
  try {
    await server.app.listen({ host: cfg.server.host, port: cfg.server.port });
  } catch (e) {
    log.error('Server konnte nicht gestartet werden', { error: (e as Error).message });
    await a.close();
    process.exit(1);
  }
  log.info('Server lauscht', { address: `${cfg.server.host}:${cfg.server.port}` });
  a.startMaintenance();

  // Kontrollierter Shutdown (SIGTERM durch systemd/Docker, Strg+C): keine neuen Anfragen,
  // laufende Requests werden beendet, danach wird der Datenbank-Pool geschlossen.
  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info('Shutdown eingeleitet – laufende Requests werden beendet', { signal, timeout_ms: cfg.server.shutdownTimeoutMs });
    const ok = await server.close(cfg.server.shutdownTimeoutMs);
    if (!ok) log.warn('Nicht alle Requests wurden rechtzeitig beendet');
    await a.close();
    log.info('Server beendet');
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

function tlsPin(args: string[]) {
  const opt = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const certFile = opt('--cert') ?? DEFAULT_TLS_CERT;
  let info;
  try {
    info = tlsInfoFromFile(certFile);
  } catch (e) {
    fail(1, `Zertifikat nicht lesbar (${certFile}): ${(e as Error).message}`);
  }
  const address = opt('--address') ?? /IP Address:([0-9.]+)/.exec(info.subjectAltName)?.[1] ?? '';
  if (args.includes('--uri')) {
    if (!address) fail(1, 'Keine IP-Adresse im Zertifikat – bitte --address angeben.');
    console.log(connectUri(address, info.pin));
    return;
  }
  console.log(`Adresse für die App:   https://${address || '<IP-Adresse>'}
Fingerabdruck (Pin):   ${info.pin}
Zertifikat (SHA-256):  ${info.certSha256}
Gültig bis:            ${info.validTo.toISOString().slice(0, 10)}`);
}

async function healthcheck(env: Record<string, string | undefined>) {
  const port = Number(env.SERVER_PORT) || 3000;
  let host = env.SERVER_HOST || '127.0.0.1';
  if (host === '0.0.0.0' || host === '::') host = '127.0.0.1';
  const url = `http://${host.includes(':') ? `[${host}]` : host}:${port}/api/v1/health/ready`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (res.status !== 200) fail(1, `Nicht gesund – HTTP ${res.status} von ${url}`);
  } catch {
    fail(1, `Server nicht erreichbar (${url})`);
  }
  console.log('OK – Server und Datenbank erreichbar.');
}

async function migrateStatusCmd(cfg: Config) {
  const a = newApp(cfg);
  let states;
  try {
    states = await migrationStatus(a.db);
  } catch (e) {
    await a.close();
    fail(1, 'Migrationsstatus nicht abrufbar: ' + (e as Error).message);
  }
  await a.close();
  let pending = 0;
  let problems = 0;
  console.log('Version  Status    Angewendet (UTC)      Name');
  for (const s of states) {
    const applied = s.appliedAt ? s.appliedAt.toISOString().slice(0, 19).replace('T', ' ') : '-';
    console.log(`${String(s.version).padStart(4, '0')}     ${s.state.padEnd(9)} ${applied.padEnd(21)} ${s.name}`);
    if (s.state === 'pending') pending++;
    if (s.state === 'modified' || s.state === 'unknown') problems++;
  }
  console.log(`\nAusstehend: ${pending}, Auffällig: ${problems} (Programmversion ${VERSION}, erwartet Schema ${latestSchemaVersion()})`);
  if (problems > 0) process.exit(1);
}

async function dbCheck(cfg: Config) {
  const a = newApp(cfg);
  const start = performance.now();
  if (!(await a.db.ping(10_000))) {
    await a.close();
    fail(1, `Datenbank nicht erreichbar (${cfg.database.display})`);
  }
  const latency = Math.round(performance.now() - start);
  let serverVersion = '?';
  let v: number;
  try {
    serverVersion = (await a.db.query<{ server_version: string }>('SHOW server_version')).rows[0].server_version;
    v = await schemaVersion(a.db);
  } catch (e) {
    await a.close();
    fail(1, 'Schema-Version nicht lesbar: ' + (e as Error).message);
  }
  await a.close();
  console.log(`Datenbank erreichbar: ${cfg.database.display}
  PostgreSQL:     ${serverVersion}
  Antwortzeit:    ${latency} ms
  Schema-Version: ${v} (erwartet ${latestSchemaVersion()})`);
  if (v !== latestSchemaVersion()) {
    console.log("Hinweis: Schema nicht aktuell – 'berichtly-server migrate' ausführen.");
    process.exit(1);
  }
}

// --- Administratorrechte und Backup-Protokoll (seit 2.0) ------------------------------------------

async function adminCmd(cfg: Config, args: string[]) {
  const [sub, email] = args;
  if (!sub || !['grant', 'revoke', 'list'].includes(sub) || (sub !== 'list' && !email)) {
    fail(2, 'Verwendung: berichtly-server admin grant <E-Mail> | admin revoke <E-Mail> | admin list');
  }
  const a = newApp(cfg);
  try {
    if (sub === 'list') {
      const admins = await listAdmins(a.db.pool);
      console.log(admins.length === 0 ? 'Keine Administratoren.' : admins.map((x) => `${x.email} (${x.status})`).join('
'));
    } else {
      const ok = await setRoleByEmail(a.db.pool, email, sub === 'grant' ? 'admin' : 'user');
      if (!ok) {
        await a.close();
        fail(1, `Kein Konto mit der E-Mail-Adresse ${email}.`);
      }
      await audit(a.db.pool, null, sub === 'grant' ? 'ADMIN_GRANTED_CLI' : 'ADMIN_REVOKED_CLI', null, email.toLowerCase().slice(0, 64));
      a.log.warn(sub === 'grant' ? 'Administratorrechte per CLI vergeben' : 'Administratorrechte per CLI entzogen');
      console.log(sub === 'grant' ? `${email} ist jetzt Administrator.` : `${email} ist kein Administrator mehr.`);
    }
  } finally {
    await a.close();
  }
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

async function backupRecord(cfg: Config, args: string[]) {
  const file = flag(args, 'file');
  const started = flag(args, 'started');
  const result = flag(args, 'result');
  const startedAt = started ? new Date(started) : null;
  if (!file || !startedAt || Number.isNaN(startedAt.getTime()) || (result !== 'SUCCESS' && result !== 'FAILED')) {
    fail(2, 'Verwendung: berichtly-server backup-record --file <name> --started <ISO-Zeit> --result SUCCESS|FAILED [...]');
  }
  const size = flag(args, 'size');
  const sha = flag(args, 'sha256');
  if (sha && !/^[0-9a-f]{64}$/.test(sha)) fail(2, '--sha256 muss 64 hexadezimale Zeichen enthalten');
  const a = newApp(cfg);
  try {
    await insertBackupRun(a.db.pool, {
      startedAt, fileName: file.slice(0, 255), sizeBytes: size && /^d+$/.test(size) ? Number(size) : null, sha256: sha ?? null,
      verified: flag(args, 'verified') === 'true', verification: flag(args, 'verification')?.slice(0, 255) ?? null,
      result, error: flag(args, 'error')?.slice(0, 255) ?? null,
    });
  } finally {
    await a.close();
  }
  console.log('Backup protokolliert.');
}

async function backupsCmd(cfg: Config) {
  const a = newApp(cfg);
  try {
    const runs = await listBackups(a.db.pool, 20);
    if (runs.length === 0) console.log('Noch keine Backups protokolliert.');
    for (const r of runs) {
      console.log(`${r.finishedAt.toISOString()}  ${r.result.padEnd(7)}  ${r.verified ? 'geprüft' : 'ungeprüft'}  ${r.fileName}${r.error ? '  ' + r.error : ''}`);
    }
  } finally {
    await a.close();
  }
}

main(process.argv.slice(2)).catch((e) => {
  process.stderr.write(`Unerwarteter Fehler: ${(e as Error).stack ?? e}\n`);
  process.exit(1);
});
