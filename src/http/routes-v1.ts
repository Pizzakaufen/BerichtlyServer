// Alle Endpunkte der API-Version 1. Bestehende Endpunkte bleiben unverändert; neue Versionen erhalten eine
// eigene Datei (routes-v2.ts unter /api/v2), Services und Datenbank werden geteilt.

import { randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { badParameter } from '../domain/errors.ts';
import { dateInRange, isoWeekFromNumber, MAX_DATE, MIN_DATE, monthRange, parseDate, weekDays, weekdayName } from '../domain/date.ts';
import {
  accountDto, dailyDto, deviceDto, emptyMeta, profileDto, REPORT_STATUSES, securityEventDto, sessionDto, weeklyDto, type DailyReport,
  type WeeklyReport,
} from '../domain/models.ts';
import type { ReportFilter } from '../db/repositories/reports.ts';
import { readDailyValues, readMeta, readProfileValues, readWeeklyValues } from '../services/requests.ts';
import { DEFAULT_PULL_LIMIT, MAX_PULL_LIMIT, parseCursor } from '../services/sync.ts';
import { type Outcome, requireApplied, type VersionedWriter } from '../services/versioned.ts';
import { type Json, optInt, optString, Validator } from '../validation/validator.ts';
import { hashKey } from './limiter.ts';
import {
  type Page, pageParams, parseIntStrict, pathParam, pathUuid, principal, query, queryInt, readJson, sendData, sendPage,
} from './respond.ts';
import type { RouteHelper } from './server.ts';

const INT32_MAX = 2 ** 31 - 1;

export function routesV1(r: RouteHelper, v1: string) {
  const { deps: d, limiters } = r;
  const authed = { auth: true };

  // System
  r.route('GET', `${v1}/health`, {}, r.system.health);
  r.route('GET', `${v1}/health/live`, {}, r.system.live);
  r.route('GET', `${v1}/health/ready`, {}, r.system.ready);

  // Authentifizierung (eigene, strengere Rate Limits gegen Missbrauch)
  r.route('POST', `${v1}/auth/register`, { limiter: limiters.register }, async (req, reply) => {
    sendData(reply, 201, await d.auth.register(readJson(req)));
  });
  r.route('POST', `${v1}/auth/login`, { limiter: limiters.login }, async (req, reply) => {
    const body = readJson(req);
    // Zusätzliches Limit pro Konto (E-Mail) – schützt auch vor Angriffen über viele IP-Adressen.
    // Der Schlüssel ist ein Hash; die E-Mail-Adresse selbst wird nirgends gespeichert.
    const email = optString(body, 'email');
    if (email !== undefined && !r.limit(limiters.account, hashKey(email.trim().toLowerCase()), reply)) return;
    sendData(reply, 200, await d.auth.login(body));
  });
  r.route('POST', `${v1}/auth/refresh`, { limiter: limiters.refresh }, async (req, reply) => {
    sendData(reply, 200, await d.auth.refresh(readJson(req)));
  });
  r.route('POST', `${v1}/auth/logout`, authed, async (req, reply) => {
    await d.auth.logout(principal(req));
    reply.code(204).send();
  });
  r.route('POST', `${v1}/auth/logout-all`, authed, async (req, reply) => {
    sendData(reply, 200, { revokedSessions: await d.auth.logoutAll(principal(req)) });
  });

  // Konto, Sitzungen und Profil
  r.route('GET', `${v1}/account`, authed, async (req, reply) => {
    sendData(reply, 200, accountDto(await d.account.get(principal(req).userId)));
  });
  r.route('PATCH', `${v1}/account`, authed, async (req, reply) => {
    sendData(reply, 200, accountDto(await d.account.update(principal(req).userId, readJson(req))));
  });
  r.route('POST', `${v1}/account/password`, { auth: true, limiter: limiters.login }, async (req, reply) => {
    await d.auth.changePassword(principal(req), readJson(req));
    reply.code(204).send();
  });
  r.route('GET', `${v1}/account/security-events`, authed, async (req, reply) => {
    const p = pageParams(req);
    const { items, total } = await d.account.securityEvents(principal(req).userId, p.limit, p.offset);
    sendPage(reply, items.map(securityEventDto), p, total);
  });
  r.route('GET', `${v1}/sessions`, authed, async (req, reply) => {
    const p = pageParams(req);
    const pr = principal(req);
    const { items, total } = await d.auth.listSessions(pr.userId, p.limit, p.offset);
    sendPage(reply, items.map((s) => sessionDto(s, s.id === pr.sessionId)), p, total);
  });
  r.route('DELETE', `${v1}/sessions/:id`, authed, async (req, reply) => {
    await d.auth.revokeSession(principal(req), pathUuid(req, 'id'));
    reply.code(204).send();
  });
  r.route('GET', `${v1}/profile`, authed, async (req, reply) => {
    sendData(reply, 200, profileDto(await d.profiles.get(principal(req).userId)));
  });
  r.route('PUT', `${v1}/profile`, authed, async (req, reply) => {
    const body = readJson(req);
    const v = new Validator();
    const version = v.int('version', optInt(body, 'version'), 1, INT32_MAX, 0, true);
    const values = readProfileValues(body, v);
    v.throwIfInvalid();
    const out = await d.profiles.update(principal(req).userId, version!, values);
    sendData(reply, 200, profileDto(requireApplied(out, 'Profil', (p) => p.version, profileDto).record));
  });

  // Tages- und Wochenberichte
  const reports = [
    { path: 'daily-reports', what: 'Tagesbericht', writer: d.reports.daily, read: readDailyValues, dto: dailyDto, daily: true },
    { path: 'weekly-reports', what: 'Wochenbericht', writer: d.reports.weekly, read: readWeeklyValues, dto: weeklyDto, daily: false },
  ] as const;
  for (const rep of reports) {
    const writer = rep.writer as VersionedWriter<unknown, DailyReport | WeeklyReport>;
    const read = rep.read as (o: Json, v: Validator) => unknown;
    const dto = rep.dto as (r: DailyReport | WeeklyReport) => unknown;
    const base = `${v1}/${rep.path}`;

    r.route('GET', base, authed, async (req, reply) => {
      const { filter, page } = reportFilter(req, rep.daily);
      const userId = principal(req).userId;
      const { items, total } = rep.daily ? await d.reports.listDaily(userId, filter) : await d.reports.listWeekly(userId, filter);
      sendPage(reply, (items as (DailyReport | WeeklyReport)[]).map(dto), page, total);
    });
    r.route('POST', base, authed, async (req, reply) => {
      const body = readJson(req);
      const p = principal(req);
      const v = new Validator();
      const rawId = optString(body, 'id');
      const id = rawId !== undefined ? v.uuid('id', rawId, true) : randomUUID();
      const values = read(body, v);
      const meta = readMeta(body, v, p.deviceRef, null);
      v.throwIfInvalid();
      writeOutcome(reply, await writer.create(p.userId, id!, values, meta), rep.what, dto, true);
    });
    r.route('GET', `${base}/:id`, authed, async (req, reply) => {
      const id = pathUuid(req, 'id');
      const userId = principal(req).userId;
      const record = rep.daily ? await d.reports.getDaily(userId, id) : await d.reports.getWeekly(userId, id);
      sendData(reply, 200, dto(record));
    });
    r.route('PUT', `${base}/:id`, authed, async (req, reply) => {
      const p = principal(req);
      const id = pathUuid(req, 'id');
      const body = readJson(req);
      const v = new Validator();
      const values = read(body, v);
      const version = v.int('version', optInt(body, 'version'), 1, INT32_MAX, 0, true);
      const bodyId = optString(body, 'id');
      if (bodyId !== undefined && bodyId !== id) v.add('id', 'must_match_path');
      const meta = readMeta(body, v, p.deviceRef, null);
      v.throwIfInvalid();
      writeOutcome(reply, await writer.update(p.userId, id, version!, values, meta), rep.what, dto, false);
    });
    r.route('DELETE', `${base}/:id`, authed, async (req, reply) => {
      const id = pathUuid(req, 'id');
      if (query(req, 'version') === '') throw badParameter('version', 'required');
      const version = queryInt(req, 'version', 0, 1, INT32_MAX);
      const p = principal(req);
      const out = await writer.delete(p.userId, id, version, emptyMeta(p.deviceRef));
      requireApplied(out, rep.what, (x) => x.version, dto);
      reply.code(204).send();
    });
  }

  // Wochen
  r.route('GET', `${v1}/weeks/current`, authed, (req, reply) => writeWeek(req, reply, null));
  r.route('GET', `${v1}/weeks/:date`, authed, (req, reply) => {
    const date = parseDate(pathParam(req, 'date'));
    if (!date || !dateInRange(date)) throw badParameter('date', 'invalid_date');
    return writeWeek(req, reply, date);
  });
  r.route('GET', `${v1}/weeks/:isoYear/:isoWeek`, authed, (req, reply) => {
    const year = parseIntStrict(pathParam(req, 'isoYear'));
    const week = parseIntStrict(pathParam(req, 'isoWeek'));
    const iso = year !== null && week !== null ? isoWeekFromNumber(year, week) : null;
    if (!iso) throw badParameter('isoWeek', 'invalid_iso_week');
    return writeWeek(req, reply, iso.start);
  });

  async function writeWeek(req: FastifyRequest, reply: FastifyReply, date: string | null) {
    const ov = await d.reports.week(principal(req).userId, date);
    sendData(reply, 200, {
      weekStart: ov.week.start,
      weekEnd: ov.week.end,
      isoYear: ov.week.year,
      isoWeek: ov.week.week,
      timezone: ov.timezone,
      today: ov.today,
      days: weekDays(ov.week).map((day) => ({
        date: day,
        dayOfWeek: weekdayName(day),
        dailyReports: ov.daily.filter((r) => r.values.date === day).map(dailyDto),
      })),
      weeklyReport: ov.weekly ? weeklyDto(ov.weekly) : null,
    });
  }

  // Synchronisierung
  r.route('POST', `${v1}/sync`, authed, async (req, reply) => {
    sendData(reply, 200, await d.sync.sync(principal(req), readJson(req)));
  });
  r.route('POST', `${v1}/sync/complete`, authed, async (req, reply) => {
    sendData(reply, 200, await d.sync.complete(principal(req), readJson(req)));
  });
  r.route('GET', `${v1}/sync/changes`, authed, async (req, reply) => {
    const cursor = parseCursor(query(req, 'cursor'));
    const limit = queryInt(req, 'limit', DEFAULT_PULL_LIMIT, 1, MAX_PULL_LIMIT);
    sendData(reply, 200, await d.sync.pull(principal(req), cursor, limit));
  });
  r.route('POST', `${v1}/sync/push`, authed, async (req, reply) => {
    sendData(reply, 200, await d.sync.push(principal(req), readJson(req)));
  });
  r.route('GET', `${v1}/sync/status`, authed, async (req, reply) => {
    sendData(reply, 200, await d.sync.status(principal(req)));
  });

  // Geräte
  r.route('POST', `${v1}/devices`, authed, async (req, reply) => {
    const { device, created } = await d.devices.register(principal(req), readJson(req));
    sendData(reply, created ? 201 : 200, deviceDto(device, true));
  });
  r.route('GET', `${v1}/devices`, authed, async (req, reply) => {
    const p = pageParams(req);
    const raw = query(req, 'includeRevoked');
    if (raw !== '' && raw !== 'true' && raw !== 'false') throw badParameter('includeRevoked', 'invalid_value:true|false');
    const pr = principal(req);
    const { items, total } = await d.devices.list(pr.userId, raw === 'true', p.limit, p.offset);
    sendPage(reply, items.map((x) => deviceDto(x, pr.deviceRef === x.ref)), p, total);
  });
  r.route('GET', `${v1}/devices/:id`, authed, async (req, reply) => {
    const id = pathUuid(req, 'id');
    const pr = principal(req);
    const dev = await d.devices.get(pr.userId, id);
    sendData(reply, 200, deviceDto(dev, pr.deviceRef === dev.ref));
  });
  r.route('PATCH', `${v1}/devices/:id`, authed, async (req, reply) => {
    const id = pathUuid(req, 'id');
    const body = readJson(req);
    const pr = principal(req);
    const dev = await d.devices.update(pr.userId, id, body);
    sendData(reply, 200, deviceDto(dev, pr.deviceRef === dev.ref));
  });
  r.route('DELETE', `${v1}/devices/:id`, authed, async (req, reply) => {
    await d.devices.revoke(principal(req), pathUuid(req, 'id'));
    reply.code(204).send();
  });
}


/** 201 (neu), 200 (geändert/idempotent), 409 (Konflikt mit Serverstand) oder 404. */
function writeOutcome<R extends { version: number }>(reply: FastifyReply, out: Outcome<R>, what: string,
  dto: (r: R) => unknown, create: boolean) {
  const applied = requireApplied(out, what, (r) => r.version, dto);
  sendData(reply, create && applied.created ? 201 : 200, dto(applied.record));
}

/** Listenfilter. Zeitraumfilter (from/to, year/month, isoYear/isoWeek) werden kombiniert (Schnittmenge). */
function reportFilter(req: FastifyRequest, daily: boolean): { filter: ReportFilter; page: Page } {
  const page = pageParams(req);
  const f: ReportFilter = { statuses: [], ascending: false, limit: page.limit, offset: page.offset };
  const date = (name: string) => {
    const raw = query(req, name);
    if (raw === '') return undefined;
    const d = parseDate(raw);
    if (!d || !dateInRange(d)) throw badParameter(name, 'invalid_date');
    return d;
  };
  const intersect = (from: string, to: string) => {
    if (f.from === undefined || f.from < from) f.from = from;
    if (f.to === undefined || to < f.to) f.to = to;
  };
  if (daily) f.date = date('date');
  f.from = date('from');
  f.to = date('to');

  if (query(req, 'year') !== '') {
    const year = queryInt(req, 'year', 0, Number(MIN_DATE.slice(0, 4)), Number(MAX_DATE.slice(0, 4)));
    let range: [string, string] = [`${year}-01-01`, `${year}-12-31`];
    if (query(req, 'month') !== '') range = monthRange(year, queryInt(req, 'month', 0, 1, 12));
    intersect(range[0], range[1]);
  } else if (query(req, 'month') !== '') {
    throw badParameter('month', 'requires_year');
  }
  if (query(req, 'isoYear') !== '' || query(req, 'isoWeek') !== '') {
    const year = parseIntStrict(query(req, 'isoYear'));
    const week = parseIntStrict(query(req, 'isoWeek'));
    const iso = year !== null && week !== null ? isoWeekFromNumber(year, week) : null;
    if (!iso) throw badParameter('isoWeek', 'invalid_iso_week');
    intersect(iso.start, iso.end);
  }
  if (f.from !== undefined && f.to !== undefined && f.to < f.from) {
    if (query(req, 'from') !== '' && query(req, 'to') !== '' && query(req, 'year') === '' && query(req, 'isoWeek') === '') {
      throw badParameter('to', 'before_from');
    }
    // Leere Schnittmenge aus mehreren Filtern ergibt eine leere Liste.
  }
  const status = query(req, 'status');
  if (status !== '') {
    for (const raw of status.split(',')) {
      const s = raw.trim();
      if (!(REPORT_STATUSES as readonly string[]).includes(s)) {
        throw badParameter('status', `invalid_value:${REPORT_STATUSES.join('|')}`);
      }
      f.statuses.push(s);
    }
  }
  const sort = query(req, 'sort');
  if (sort === 'date_asc') f.ascending = true;
  else if (sort !== '' && sort !== 'date_desc') throw badParameter('sort', 'invalid_value:date_asc|date_desc');
  return { filter: f, page };
}

