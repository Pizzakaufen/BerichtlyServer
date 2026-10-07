// Tages- und Wochenberichte sowie Wochenübersicht.

import { notFound } from '../domain/errors.ts';
import { type IsoWeek, todayIn, weekContaining } from '../domain/date.ts';
import type { DailyReport, DailyValues, WeeklyReport, WeeklyValues } from '../domain/models.ts';
import type { Database } from '../db/pool.ts';
import * as repo from '../db/repositories/reports.ts';
import { findUserById } from '../db/repositories/users.ts';
import { VersionedWriter } from './versioned.ts';

export interface WeekOverview {
  week: IsoWeek;
  timezone: string;
  today: string; // "heute" in der Zeitzone des Benutzers
  daily: DailyReport[];
  weekly: WeeklyReport | null;
}

export class ReportService {
  private readonly db: Database;
  readonly daily: VersionedWriter<DailyValues, DailyReport>;
  readonly weekly: VersionedWriter<WeeklyValues, WeeklyReport>;
  now: () => Date;

  constructor(db: Database, now: () => Date) {
    this.db = db;
    this.now = now;
    this.daily = new VersionedWriter(db, repo.dailyStore);
    this.weekly = new VersionedWriter(db, repo.weeklyStore);
  }

  async getDaily(userId: string, id: string) {
    const r = await repo.findActiveDaily(this.db.pool, userId, id);
    if (!r) throw notFound('Tagesbericht');
    return r;
  }

  listDaily(userId: string, f: repo.ReportFilter) {
    return repo.listDaily(this.db.pool, userId, f);
  }

  async getWeekly(userId: string, id: string) {
    const r = await repo.findActiveWeekly(this.db.pool, userId, id);
    if (!r) throw notFound('Wochenbericht');
    return r;
  }

  listWeekly(userId: string, f: repo.ReportFilter) {
    return repo.listWeekly(this.db.pool, userId, f);
  }

  /**
   * Woche (Montag–Sonntag), die date enthält. Ohne Datum wird "heute" in der Zeitzone des Benutzers
   * bestimmt – nie in der des Servers. Sommer-/Winterzeit sind über die IANA-Zeitzone abgedeckt.
   * Alle Abfragen lesen aus einem gemeinsamen Snapshot.
   */
  week(userId: string, date: string | null): Promise<WeekOverview> {
    return this.db.snapshot(async (c) => {
      const user = await findUserById(c, userId);
      if (!user) throw notFound('Konto');
      const today = todayIn(this.now(), user.timezone);
      const week = weekContaining(date ?? today);
      return {
        week,
        timezone: user.timezone,
        today,
        daily: await repo.listDailyInRange(c, userId, week.start, week.end),
        weekly: await repo.findActiveWeeklyForWeek(c, userId, week.start),
      };
    });
  }
}
