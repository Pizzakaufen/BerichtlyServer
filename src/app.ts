// Verdrahtet Konfiguration, Datenbank, Services und HTTP-Schicht.

import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type { Config } from './config/config.ts';
import { todayIn, weekContaining, weekDays } from './domain/date.ts';
import { emptyMeta } from './domain/models.ts';
import { Database } from './db/pool.ts';
import { type MaintenanceResult, runMaintenance } from './db/repositories/maintenance.ts';
import { buildServer, type Server } from './http/server.ts';
import { PasswordHasher } from './security/password.ts';
import { Tokens } from './security/tokens.ts';
import { AccountService, DeviceService, ProfileService } from './services/account.ts';
import { AuthService } from './services/auth.ts';
import { ReportService } from './services/reports.ts';
import { SyncService } from './services/sync.ts';
import type { Logger } from './util/logger.ts';

/** Programmversion – einzige Quelle ist package.json. */
export const VERSION: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const OPENAPI_FILE = new URL('../api/openapi.yaml', import.meta.url);

export class App {
  readonly cfg: Config;
  readonly log: Logger;
  readonly db: Database;
  readonly auth: AuthService;
  readonly account: AccountService;
  readonly profiles: ProfileService;
  readonly reports: ReportService;
  readonly sync: SyncService;
  readonly devices: DeviceService;
  private maintenanceTimer: NodeJS.Timeout | null = null;

  /** now ist die Uhr für fachliche Berechnungen ("heute") und Tokens (in Tests steuerbar). */
  constructor(cfg: Config, log: Logger, now: () => Date = () => new Date()) {
    this.cfg = cfg;
    this.log = log;
    this.db = Database.create(cfg.database, (err) => {
      // Fehler auf ruhenden Verbindungen (z. B. Neustart von PostgreSQL) – der Pool ersetzt sie.
      log.warn('Datenbankverbindung unterbrochen', { error: err.message });
    });
    this.auth = new AuthService(this.db, cfg.auth, new PasswordHasher(), new Tokens({
      secret: cfg.auth.jwtSecret, issuer: cfg.auth.issuer, audience: cfg.auth.audience,
      ttlSec: cfg.auth.accessTokenTtlSec, now,
    }), log);
    this.account = new AccountService(this.db);
    this.profiles = new ProfileService(this.db);
    this.reports = new ReportService(this.db, now);
    this.sync = new SyncService(this.db, this.reports, this.profiles, now, log);
    this.devices = new DeviceService(this.db, log);
  }

  buildServer(): Promise<Server> {
    return buildServer({
      config: this.cfg, db: this.db, log: this.log, auth: this.auth, account: this.account, profiles: this.profiles,
      reports: this.reports, sync: this.sync, devices: this.devices, version: VERSION,
      openapi: this.cfg.apiDocs && existsSync(OPENAPI_FILE) ? readFileSync(OPENAPI_FILE, 'utf8') : null,
    });
  }

  /** Ein Wartungslauf; das Ergebnis wird ohne Inhalte protokolliert. */
  async runMaintenance(): Promise<MaintenanceResult> {
    const r = this.cfg.retention;
    try {
      const res = await runMaintenance(this.db, r);
      if (res.skipped) {
        this.log.info('Wartung übersprungen – läuft bereits an anderer Stelle');
      } else {
        this.log.info('Wartung abgeschlossen', {
          tombstones: res.tombstonesPurged, min_valid_cursor: res.minValidCursor, operations: res.operationsPurged,
          security_events: res.securityEventsPurged, sessions: res.sessionsPurged, refresh_tokens: res.refreshTokensPurged,
        });
      }
      return res;
    } catch (err) {
      this.log.error('Wartung fehlgeschlagen', { error: (err as Error).message });
      throw err;
    }
  }

  /**
   * Wartung im eingestellten Intervall (erster Lauf nach 5 Minuten). Mehrere Instanzen sind über eine
   * Datenbanksperre koordiniert. Der Timer hält den Prozess nicht am Leben.
   */
  startMaintenance(firstDelayMs = 5 * 60_000) {
    const interval = this.cfg.maintenanceIntervalMs;
    if (interval <= 0) return;
    const tick = async () => {
      try {
        await this.runMaintenance();
      } catch { /* bereits protokolliert */ }
      if (this.maintenanceTimer) this.maintenanceTimer = setTimeout(tick, interval).unref();
    };
    this.maintenanceTimer = setTimeout(tick, firstDelayMs).unref();
  }

  stopMaintenance() {
    if (this.maintenanceTimer) clearTimeout(this.maintenanceTimer);
    this.maintenanceTimer = null;
  }

  /**
   * Legt ein Entwicklungskonto mit wenigen, eindeutig gekennzeichneten Beispielberichten an. Nur mit
   * APP_ENV=development und nur auf ausdrücklichen Befehl (`seed-dev`) – niemals automatisch, niemals in
   * Produktion. Das Passwort wird zufällig erzeugt und nur einmal angezeigt.
   */
  async seedDev(): Promise<{ email: string; password: string }> {
    if (this.cfg.env !== 'development') throw new Error('seed-dev ist nur mit APP_ENV=development erlaubt');
    const email = 'dev@berichtly.local';
    const password = randomBytes(18).toString('base64url');
    const timezone = 'Europe/Berlin';
    let userId: string;
    try {
      userId = (await this.auth.register({ email, password, timezone })).account.id;
    } catch (err) {
      throw new Error(`Entwicklungskonto konnte nicht angelegt werden (existiert es bereits?): ${(err as Error).message}`);
    }
    const week = weekContaining(todayIn(new Date(), timezone));
    for (const [i, date] of weekDays(week).slice(0, 3).entries()) {
      await this.reports.daily.create(userId, randomUUID(), {
        date, text: `[Entwicklungsdaten] Beispieltätigkeit ${i + 1}`, note: '', orderIndex: 0, status: 'DRAFT',
      }, emptyMeta());
    }
    return { email, password };
  }

  async close() {
    this.stopMaintenance();
    await this.db.close();
  }
}
