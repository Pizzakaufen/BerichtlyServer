// Admin-Dashboard (seit 2.0) unter /admin – serverseitig gerendertes HTML ohne JavaScript.
//
// Schutzmaßnahmen:
// - nur aktiv mit ADMIN_DASHBOARD_ENABLED=true, sonst existieren die Routen nicht (404);
// - Anmeldung nur für Konten mit Rolle 'admin', eigene Rate-Limits, Kontosperre bei Fehlversuchen;
// - Sitzungs-Cookie HttpOnly, SameSite=Strict, Secure (in Produktion immer), Pfad /admin, Leerlauf- und Höchstdauer;
// - jede verändernde Anfrage braucht das CSRF-Token der Sitzung, eine Bestätigung und eine gleiche Herkunft;
// - strenge Content-Security-Policy, keine Zwischenspeicherung, kein Einbetten in Frames;
// - angezeigt werden nur Metadaten (E-Mail, Status, Geräte, Zeitpunkte, Fehlercodes) – nie Berichtsinhalte oder Tokens.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { latestSchemaVersion, schemaVersion } from '../db/migrate.ts';
import * as repo from '../db/repositories/admin.ts';
import { type AdminPrincipal, AdminService, sameToken } from '../services/admin.ts';
import { Limiter, type Metrics } from './limiter.ts';
import type { Deps } from './server.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE_SIZE = 50;

export function adminRoutes(app: FastifyInstance, d: Deps, metrics: Metrics, service: AdminService) {
  const cfg = d.config.admin;
  const cookieName = cfg.cookieSecure ? '__Host-berichtly_admin' : 'berichtly_admin';
  // __Host-Cookies verlangen Path=/; ohne Secure (nur lokal) auf /admin beschränkt.
  const cookiePath = cfg.cookieSecure ? '/' : '/admin';
  const loginLimiter = new Limiter(cfg.loginPerMinute);
  const actionLimiter = new Limiter(30);

  const headers = (reply: FastifyReply) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('Content-Security-Policy',
      "default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    reply.header('X-Robots-Tag', 'noindex, nofollow');
  };

  const html = (reply: FastifyReply, status: number, body: string) => {
    headers(reply);
    return reply.code(status).type('text/html; charset=utf-8').send(body);
  };

  const redirect = (reply: FastifyReply, to: string) => {
    headers(reply);
    return reply.code(303).header('Location', to).send();
  };

  const setCookie = (reply: FastifyReply, value: string, maxAgeSec: number) => {
    reply.header('Set-Cookie', `${cookieName}=${value}; Path=${cookiePath}; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}` +
      (cfg.cookieSecure ? '; Secure' : ''));
  };

  const cookieValue = (req: FastifyRequest): string | undefined => {
    for (const part of (req.headers.cookie ?? '').split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k === cookieName) return v.join('=');
    }
    return undefined;
  };

  /** Gleiche Herkunft: Origin (falls gesendet) muss zum Host passen; Sec-Fetch-Site darf nicht cross-site sein. */
  const sameOrigin = (req: FastifyRequest): boolean => {
    const site = req.headers['sec-fetch-site'];
    if (typeof site === 'string' && !['same-origin', 'none'].includes(site)) return false;
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
      return new URL(origin).host === req.headers.host;
    } catch {
      return false;
    }
  };

  const form = (req: FastifyRequest): URLSearchParams => {
    const body = req.body;
    const text = Buffer.isBuffer(body) ? body.toString('utf8') : typeof body === 'string' ? body : '';
    return new URLSearchParams(text.length > 8192 ? '' : text);
  };

  /** Angemeldeter Administrator oder Weiterleitung zur Anmeldung (GET) bzw. 403 (POST). */
  const principal = async (req: FastifyRequest, reply: FastifyReply): Promise<AdminPrincipal | null> => {
    const p = await service.authenticate(cookieValue(req));
    if (p) return p;
    if (req.method === 'GET' || req.method === 'HEAD') redirect(reply, '/admin/login');
    else html(reply, 403, page('Nicht angemeldet', null, '<p>Bitte erneut anmelden.</p><p><a href="/admin/login">Zur Anmeldung</a></p>'));
    return null;
  };

  /** Prüft CSRF-Token, Herkunft, Bestätigung und Rate-Limit einer verändernden Anfrage. */
  const checkAction = (req: FastifyRequest, reply: FastifyReply, p: AdminPrincipal, f: URLSearchParams, needsConfirm = true): boolean => {
    const limited = actionLimiter.allow(p.userId);
    if (!limited.ok) {
      html(reply, 429, page('Zu viele Aktionen', p, '<p>Bitte kurz warten und erneut versuchen.</p>'));
      return false;
    }
    if (!sameOrigin(req) || !sameToken(f.get('csrf') ?? '', p.csrfToken)) {
      html(reply, 403, page('Abgelehnt', p, '<p>Die Anfrage konnte nicht überprüft werden (Sicherheitstoken fehlt oder ist ungültig). Bitte die Seite neu laden.</p>'));
      return false;
    }
    if (needsConfirm && f.get('confirm') !== 'yes') {
      html(reply, 400, page('Bestätigung fehlt', p, '<p>Bitte die Aktion ausdrücklich bestätigen (Häkchen setzen).</p><p><a href="/admin/users">Zurück zu den Benutzern</a></p>'));
      return false;
    }
    return true;
  };

  // --- Statische Datei ----------------------------------------------------------------------

  app.get('/admin/admin.css', (_req, reply) => {
    reply.header('Cache-Control', 'public, max-age=3600');
    return reply.type('text/css; charset=utf-8').send(CSS);
  });

  // --- Anmeldung ------------------------------------------------------------------------------

  app.get('/admin/login', async (req, reply) => {
    if (await service.authenticate(cookieValue(req))) return redirect(reply, '/admin');
    return html(reply, 200, loginPage(null));
  });

  app.post('/admin/login', async (req, reply) => {
    const limited = loginLimiter.allow(req.ip);
    if (!limited.ok) {
      reply.header('Retry-After', String(limited.retryAfter));
      return html(reply, 429, loginPage('Zu viele Anmeldeversuche. Bitte später erneut versuchen.'));
    }
    if (!sameOrigin(req)) return html(reply, 403, loginPage('Die Anfrage konnte nicht überprüft werden.'));
    const f = form(req);
    const result = await service.login(f.get('email') ?? '', f.get('password') ?? '');
    if (!result.ok) {
      return html(reply, result.reason === 'LOCKED' ? 429 : 401,
        loginPage(result.reason === 'LOCKED' ? 'Zu viele Fehlversuche – das Konto ist vorübergehend gesperrt.' : 'E-Mail-Adresse oder Passwort ist falsch, oder das Konto hat keine Administratorrechte.'));
    }
    setCookie(reply, result.cookie, cfg.sessionMaxSec);
    return redirect(reply, '/admin');
  });

  app.post('/admin/logout', async (req, reply) => {
    const p = await principal(req, reply);
    if (!p) return;
    if (!checkAction(req, reply, p, form(req), false)) return;
    await service.logout(p);
    setCookie(reply, '', 0);
    return redirect(reply, '/admin/login');
  });

  // --- Übersicht ------------------------------------------------------------------------------

  app.get('/admin', async (req, reply) => {
    const p = await principal(req, reply);
    if (!p) return;
    const q = d.db.pool;
    const start = performance.now();
    const dbUp = await d.db.ping(3000);
    const latency = Math.round(performance.now() - start);
    let counts: Record<string, number> | null = null;
    let bySync: Record<string, number> = {};
    let recent: repo.DeviceRow[] = [];
    let schema = -1;
    let pg = '';
    let securityFailures = 0;
    if (dbUp) {
      const r = (await q.query<Record<string, string>>(
        `SELECT (SELECT count(*) FROM users) AS accounts,
                (SELECT count(*) FROM users WHERE status = 'DISABLED') AS disabled,
                (SELECT count(*) FROM devices WHERE revoked_at IS NULL) AS devices,
                (SELECT count(*) FROM devices WHERE revoked_at IS NULL AND last_seen_at > now() - interval '24 hours') AS active24,
                (SELECT count(*) FROM daily_reports WHERE deleted_at IS NULL) AS daily,
                (SELECT count(*) FROM weekly_reports WHERE deleted_at IS NULL) AS weekly,
                pg_database_size(current_database()) AS size`)).rows[0];
      counts = Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Number(v)]));
      bySync = Object.fromEntries((await q.query<{ sync_status: string; n: string }>(
        'SELECT sync_status, count(*) AS n FROM devices WHERE revoked_at IS NULL GROUP BY sync_status')).rows.map((x) => [x.sync_status, Number(x.n)]));
      recent = (await repo.syncHistory(q, false, 8)).filter((x) => x.lastSuccessAt);
      schema = await schemaVersion(d.db).catch(() => -1);
      pg = await repo.postgresVersion(q).catch(() => '');
      securityFailures = Number((await q.query<{ n: string }>(
        "SELECT count(*) AS n FROM security_events WHERE created_at > now() - interval '24 hours' AND event_type LIKE '%FAILED%'")).rows[0]?.n ?? 0);
    }
    const viaProxy = d.config.server.trustProxy && typeof req.headers['x-forwarded-proto'] === 'string';
    const m = metrics.snapshot();
    const mem = process.memoryUsage();
    const body = `
      <section class="grid">
        ${card('Node.js (API)', 'Läuft', 'ok', `Version ${esc(d.version)} · Node ${esc(process.version)} · seit ${esc(fmt(metrics.started))}`)}
        ${card('PostgreSQL', dbUp ? 'Erreichbar' : 'Nicht erreichbar', dbUp ? 'ok' : 'bad',
          dbUp ? `${esc(pg)} · ${latency} ms · Schema ${schema}${schema >= latestSchemaVersion() ? ' (aktuell)' : ' (veraltet – migrate ausführen)'}` : 'Prüfe Dienst und Zugangsdaten.')}
        ${card('Nginx', viaProxy ? 'Anfrage über Proxy' : 'Direkt', viaProxy ? 'ok' : 'warn',
          viaProxy ? `Diese Seite kam über den vertrauenswürdigen Reverse Proxy (${esc(String(req.headers['x-forwarded-proto']))}).`
            : 'Diese Anfrage kam nicht über einen vertrauenswürdigen Proxy (TRUST_PROXY aus oder direkter Zugriff). Den Dienststatus von Nginx selbst kann die API nicht sicher abfragen.')}
        ${card('API-Antworten', `${m.responses5xx} Fehler (5xx)`, m.responses5xx > 0 ? 'warn' : 'ok',
          `${m.requestsTotal} Anfragen seit Start · ${m.rateLimited} begrenzt · ${m.unhandledErrors} unbehandelt`)}
      </section>
      ${counts ? `
      <section class="grid">
        ${card('Konten', String(counts.accounts), 'neutral', `${counts.disabled} gesperrt`)}
        ${card('Aktive Geräte', String(counts.devices), 'neutral', `${counts.active24} in den letzten 24 h gesehen`)}
        ${card('Synchronisierung', `${bySync.FAILED ?? 0} Fehler · ${bySync.CONFLICT ?? 0} Konflikte`, (bySync.FAILED ?? 0) > 0 ? 'warn' : 'ok',
          `${bySync.SUCCESS ?? 0} zuletzt erfolgreich · ${bySync.NEVER ?? 0} nie`)}
        ${card('Speicher', `${Math.round(counts.size / 2 ** 20)} MB Datenbank`, 'neutral',
          `${counts.daily} Tages-, ${counts.weekly} Wochenberichte · Heap ${Math.floor(mem.heapUsed / 2 ** 20)} MB`)}
      </section>
      <p class="hint">Ausstehende Übertragungen liegen auf den Geräten und sind dem Server erst nach dem Hochladen bekannt.
        Sichtbar sind gemeldete Fehler und Konflikte. Fehlgeschlagene Anmeldungen (24 h): ${securityFailures}.</p>
      <h2>Letzte erfolgreiche Synchronisierungen</h2>
      ${recent.length === 0 ? '<p class="hint">Noch keine.</p>' : table(['Zeitpunkt', 'Konto', 'Gerät', 'App'], recent.map((x) => [
        fmt(x.lastSuccessAt), `<a href="/admin/users/${x.userId}">${esc(x.email)}</a>`, esc(x.name || x.platform), esc(x.appVersion)]), true)}
      ` : '<p class="bad">Ohne Datenbank sind keine Kennzahlen verfügbar.</p>'}`;
    return html(reply, dbUp ? 200 : 503, page('Übersicht', p, body));
  });

  // --- Benutzer -------------------------------------------------------------------------------

  app.get('/admin/users', async (req, reply) => {
    const p = await principal(req, reply);
    if (!p) return;
    const query = req.query as Record<string, string | undefined>;
    const search = (query.q ?? '').slice(0, 100);
    const pageNo = Math.max(1, Math.min(10_000, Number.parseInt(query.page ?? '1', 10) || 1));
    const { rows, total } = await repo.searchUsers(d.db.pool, search, PAGE_SIZE, (pageNo - 1) * PAGE_SIZE);
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const body = `
      <form method="get" action="/admin/users" class="search">
        <label for="q">E-Mail enthält</label>
        <input id="q" name="q" value="${esc(search)}" maxlength="100" autocomplete="off">
        <button type="submit">Suchen</button>
      </form>
      <p class="hint">${total} ${total === 1 ? 'Konto' : 'Konten'} · Seite ${pageNo} von ${pages}</p>
      ${table(['E-Mail', 'Status', 'Rolle', 'Geräte', 'Letzte Anmeldung', 'Letzte Synchronisierung'], rows.map((u) => [
        `<a href="/admin/users/${u.id}">${esc(u.email)}</a>`, statusBadge(u.status, u.locked), esc(u.role), String(u.devices),
        fmt(u.lastLoginAt), fmt(u.lastSyncAt)]), true)}
      <nav class="pager">
        ${pageNo > 1 ? `<a href="/admin/users?q=${encodeURIComponent(search)}&page=${pageNo - 1}">← Zurück</a>` : ''}
        ${pageNo < pages ? `<a href="/admin/users?q=${encodeURIComponent(search)}&page=${pageNo + 1}">Weiter →</a>` : ''}
      </nav>`;
    return html(reply, 200, page('Benutzer', p, body));
  });

  app.get('/admin/users/:id', async (req, reply) => {
    const p = await principal(req, reply);
    if (!p) return;
    const id = (req.params as { id: string }).id;
    const user = UUID.test(id) ? await repo.findUser(d.db.pool, id) : null;
    if (!user) return html(reply, 404, page('Nicht gefunden', p, '<p>Dieses Konto gibt es nicht.</p>'));
    const devices = await repo.devicesOf(d.db.pool, id);
    const activeSessions = await repo.activeSessionCount(d.db.pool, id);
    const self = id === p.userId;
    const body = `
      <dl class="facts">
        <dt>E-Mail</dt><dd>${esc(user.email)}</dd>
        <dt>Status</dt><dd>${statusBadge(user.status, user.locked)}</dd>
        <dt>Rolle</dt><dd>${esc(user.role)}</dd>
        <dt>Angelegt</dt><dd>${fmt(user.createdAt)}</dd>
        <dt>Letzte Anmeldung</dt><dd>${fmt(user.lastLoginAt)}</dd>
        <dt>Aktive App-Sitzungen</dt><dd>${activeSessions}</dd>
      </dl>
      <h2>Geräte</h2>
      ${devices.length === 0 ? '<p class="hint">Keine Geräte registriert.</p>' : table(
        ['Gerät', 'App', 'Zuletzt gesehen', 'Synchronisierung', 'Letzter Erfolg', 'Fehlercode', ''],
        devices.map((x) => [
          esc(x.name || x.platform) + (x.revoked ? ' <span class="badge neutral">abgemeldet</span>' : ''), esc(x.appVersion), fmt(x.lastSeenAt),
          syncBadge(x.syncStatus, x.conflicts), fmt(x.lastSuccessAt), esc(x.lastErrorCode ?? '–'),
          x.revoked ? '' : actionForm(`/admin/users/${id}/devices/${x.ref}/revoke`, p, 'Gerät abmelden', 'Gerät abmelden (Sitzungen beenden, Berichte bleiben erhalten)')]), true)}
      <h2>Aktionen</h2>
      ${self ? '<p class="hint">Das eigene Konto kann hier nicht gesperrt werden.</p>' : `
        <div class="actions">
          ${user.status === 'ACTIVE'
            ? actionForm(`/admin/users/${id}/disable`, p, 'Konto sperren', 'Konto sperren und alle App-Sitzungen beenden (Daten bleiben erhalten)')
            : actionForm(`/admin/users/${id}/enable`, p, 'Konto freigeben', 'Konto wieder freigeben')}
          ${actionForm(`/admin/users/${id}/revoke-sessions`, p, 'Alle Sitzungen beenden', 'Alle App-Sitzungen beenden (erneute Anmeldung nötig)')}
        </div>`}
      <p class="hint">Berichtsinhalte werden im Dashboard bewusst nicht angezeigt.</p>`;
    return html(reply, 200, page(user.email, p, body));
  });

  const userAction = (path: string, run: (p: AdminPrincipal, id: string, params: Record<string, string>) => Promise<string | null>) =>
    app.post(path, async (req, reply) => {
      const p = await principal(req, reply);
      if (!p) return;
      const params = req.params as Record<string, string>;
      if (!UUID.test(params.id) || (params.ref !== undefined && !UUID.test(params.ref))) {
        return html(reply, 404, page('Nicht gefunden', p, '<p>Unbekanntes Ziel.</p>'));
      }
      if (!checkAction(req, reply, p, form(req))) return;
      const error = await run(p, params.id, params);
      if (error) return html(reply, 400, page('Nicht möglich', p, `<p>${esc(error)}</p><p><a href="/admin/users/${params.id}">Zurück</a></p>`));
      return redirect(reply, `/admin/users/${params.id}`);
    });

  userAction('/admin/users/:id/disable', async (p, id) => {
    const r = await service.setUserStatus(p, id, false);
    return r === 'SELF' ? 'Das eigene Konto kann nicht gesperrt werden.' : r === 'NOT_FOUND' ? 'Konto nicht gefunden.' : null;
  });
  userAction('/admin/users/:id/enable', async (p, id) => {
    const r = await service.setUserStatus(p, id, true);
    return r === 'NOT_FOUND' ? 'Konto nicht gefunden.' : r === 'SELF' ? 'Nicht möglich.' : null;
  });
  userAction('/admin/users/:id/revoke-sessions', async (p, id) => {
    await service.revokeSessions(p, id);
    return null;
  });
  userAction('/admin/users/:id/devices/:ref/revoke', async (p, id, params) => {
    await service.revokeDevice(p, id, params.ref);
    return null;
  });

  // --- Synchronisierung -----------------------------------------------------------------------

  app.get('/admin/sync', async (req, reply) => {
    const p = await principal(req, reply);
    if (!p) return;
    const onlyProblems = (req.query as Record<string, string | undefined>).problems === '1';
    const rows = await repo.syncHistory(d.db.pool, onlyProblems, 200);
    const ops = await repo.recentOperations(d.db.pool);
    const body = `
      <p class="hint">Je Gerät der zuletzt gemeldete Stand. Synchronisierungen starten immer auf dem Gerät: Fehlgeschlagene Vorgänge
        wiederholt die App automatisch (Netz zurück, App-Start, regelmäßig) oder der Benutzer manuell. Eine Wiederholung vom
        Server aus ist im Protokoll nicht vorgesehen. Konflikte entscheidet der Benutzer in der App – der Server überschreibt nie still.</p>
      <p>Verarbeitete Änderungen in 24 h: ${Object.entries(ops).map(([k, v]) => `${esc(k)} ${v}`).join(' · ') || 'keine'}</p>
      <p>${onlyProblems ? '<a href="/admin/sync">Alle anzeigen</a>' : '<a href="/admin/sync?problems=1">Nur Fehler und Konflikte</a>'}</p>
      ${table(['Konto', 'Gerät', 'Status', 'Letzter Erfolg', 'Letzter Fehler', 'Fehlercode', 'App'], rows.map((x) => [
        `<a href="/admin/users/${x.userId}">${esc(x.email)}</a>`, esc(x.name || x.platform), syncBadge(x.syncStatus, x.conflicts),
        fmt(x.lastSuccessAt), fmt(x.lastFailedAt), esc(x.lastErrorCode ?? '–'), esc(x.appVersion)]), true)}`;
    return html(reply, 200, page('Synchronisierung', p, body));
  });

  // --- System ---------------------------------------------------------------------------------

  app.get('/admin/system', async (req, reply) => {
    const p = await principal(req, reply);
    if (!p) return;
    const q = d.db.pool;
    const [migrations, backups, audit, schema, pg] = await Promise.all([
      repo.migrations(q).catch(() => []), repo.listBackups(q, 10).catch(() => []), repo.listAudit(q, 30).catch(() => []),
      schemaVersion(d.db).catch(() => -1), repo.postgresVersion(q).catch(() => ''),
    ]);
    const free = await diskFree(cfg.backupDir);
    const freeData = await diskFree('.');
    const lastOk = backups.find((b) => b.result === 'SUCCESS');
    const body = `
      <dl class="facts">
        <dt>Serverversion</dt><dd>${esc(d.version)}</dd>
        <dt>API</dt><dd>/api/v1</dd>
        <dt>Node.js</dt><dd>${esc(process.version)}</dd>
        <dt>PostgreSQL</dt><dd>${esc(pg || 'nicht erreichbar')}</dd>
        <dt>Schema</dt><dd>${schema} von ${latestSchemaVersion()}${schema >= latestSchemaVersion() ? ' (aktuell)' : ' – <strong>migrate ausführen</strong>'}</dd>
        <dt>Freier Speicher (Programm)</dt><dd>${freeData >= 0 ? `${freeData} MB` : 'unbekannt'}</dd>
        <dt>Freier Speicher (Backups)</dt><dd>${free >= 0 ? `${free} MB in ${esc(cfg.backupDir)}` : `unbekannt (${esc(cfg.backupDir)} nicht lesbar)`}</dd>
        <dt>Letztes geprüftes Backup</dt><dd>${lastOk ? `${fmt(lastOk.finishedAt)}${lastOk.verified ? ' · Struktur geprüft' : ' · <strong>nicht geprüft</strong>'}` : '<strong>keines</strong>'}</dd>
      </dl>
      <h2>Backups</h2>
      ${backups.length === 0 ? '<p class="hint">Noch keine Backups protokolliert. Siehe docs/BACKUP.md (deploy/backup.sh).</p>' : table(
        ['Zeitpunkt', 'Datei', 'Größe', 'Prüfung', 'Ergebnis'], backups.map((b) => [
          fmt(b.finishedAt), esc(b.fileName), b.sizeBytes === null ? '–' : `${Math.round(b.sizeBytes / 1024)} KB`,
          esc(b.verification ?? (b.verified ? 'geprüft' : 'nicht geprüft')),
          b.result === 'SUCCESS' ? '<span class="badge ok">Erfolg</span>' : `<span class="badge bad">Fehler</span> ${esc(b.error ?? '')}`]), true)}
      <p class="hint">„Struktur geprüft“ heißt: pg_restore konnte das gesamte Archiv lesen und sein Inhaltsverzeichnis erstellen.
        Eine vollständige Probe-Wiederherstellung in eine Testdatenbank ist zusätzlich empfehlenswert (docs/BACKUP.md).</p>
      <h2>Migrationen</h2>
      ${table(['Version', 'Name', 'Angewendet'], migrations.map((m) => [String(m.version), esc(m.name), fmt(m.appliedAt)]), true)}
      <h2>Verwaltungsprotokoll</h2>
      ${audit.length === 0 ? '<p class="hint">Noch keine Einträge.</p>' : table(['Zeitpunkt', 'Admin', 'Aktion', 'Ziel'], audit.map((a) => [
        fmt(a.at), esc(a.admin ?? '–'), esc(a.action), esc(a.target ?? a.targetRef ?? '–')]), true)}`;
    return html(reply, 200, page('System', p, body));
  });
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** HTML-Escaping für alle dynamischen Werte. */
export function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const fmt = (d: Date | null | undefined) => (d ? esc(d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC') : '–');

function page(title: string, p: AdminPrincipal | null, body: string): string {
  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(title)} – Berichtly Admin</title>
<link rel="stylesheet" href="/admin/admin.css">
</head>
<body>
<header>
  <div class="brand">BERICHTLY · ADMIN</div>
  ${p ? `<nav>
    <a href="/admin">Übersicht</a><a href="/admin/users">Benutzer</a><a href="/admin/sync">Synchronisierung</a><a href="/admin/system">System</a>
  </nav>
  <form method="post" action="/admin/logout" class="logout">
    <input type="hidden" name="csrf" value="${esc(p.csrfToken)}">
    <span>${esc(p.email)}</span><button type="submit">Abmelden</button>
  </form>` : ''}
</header>
<main>
<h1>${esc(title)}</h1>
${body}
</main>
</body>
</html>`;
}

function loginPage(error: string | null): string {
  return page('Anmeldung', null, `
    ${error ? `<p class="error" role="alert">${esc(error)}</p>` : ''}
    <form method="post" action="/admin/login" class="login">
      <label for="email">E-Mail</label>
      <input id="email" name="email" type="email" autocomplete="username" required maxlength="254">
      <label for="password">Passwort</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required maxlength="128">
      <button type="submit">Anmelden</button>
    </form>
    <p class="hint">Nur für Konten mit Administratorrechten. Rechte vergibt der Betreiber per CLI.</p>`);
}

function card(title: string, value: string, tone: 'ok' | 'warn' | 'bad' | 'neutral', detail: string): string {
  return `<div class="card ${tone}"><div class="card-title">${esc(title)}</div><div class="card-value">${esc(value)}</div><div class="card-detail">${detail}</div></div>`;
}

/** Tabelle; Zellen sind bereits escaptes HTML, wenn [trusted] gesetzt ist. */
function table(head: string[], rows: string[][], trusted: boolean): string {
  const cell = (c: string) => (trusted ? c : esc(c));
  return `<div class="table"><table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${
    rows.length === 0 ? `<tr><td colspan="${head.length}">Keine Einträge.</td></tr>` : rows.map((r) => `<tr>${r.map((c) => `<td>${cell(c)}</td>`).join('')}</tr>`).join('')
  }</tbody></table></div>`;
}

function actionForm(action: string, p: AdminPrincipal, label: string, confirmText: string): string {
  return `<form method="post" action="${esc(action)}" class="action">
    <input type="hidden" name="csrf" value="${esc(p.csrfToken)}">
    <label><input type="checkbox" name="confirm" value="yes" required> ${esc(confirmText)}</label>
    <button type="submit">${esc(label)}</button>
  </form>`;
}

function statusBadge(status: string, locked: boolean): string {
  if (status === 'DISABLED') return '<span class="badge bad">gesperrt</span>';
  if (locked) return '<span class="badge warn">vorübergehend gesperrt</span>';
  return '<span class="badge ok">aktiv</span>';
}

function syncBadge(status: string, conflicts: number): string {
  switch (status) {
    case 'SUCCESS': return '<span class="badge ok">erfolgreich</span>';
    case 'CONFLICT': return `<span class="badge warn">${conflicts} Konflikt${conflicts === 1 ? '' : 'e'}</span>`;
    case 'FAILED': return '<span class="badge bad">fehlgeschlagen</span>';
    default: return '<span class="badge neutral">nie</span>';
  }
}

async function diskFree(path: string): Promise<number> {
  try {
    const { statfs } = await import('node:fs/promises');
    const s = await statfs(path);
    return Math.floor((s.bavail * s.bsize) / 2 ** 20);
  } catch {
    return -1;
  }
}

const CSS = `
:root{--bg:#0f1115;--card:#171a21;--line:#2a2f3a;--text:#e7e9ee;--muted:#9aa3b2;--primary:#8b93ff;--ok:#3fb27f;--warn:#e0a03a;--bad:#e5564b}
@media (prefers-color-scheme: light){:root{--bg:#f6f7f9;--card:#fff;--line:#dfe3ea;--text:#151821;--muted:#5a6273;--primary:#4a52d6}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
header{display:flex;flex-wrap:wrap;gap:16px;align-items:center;padding:12px 20px;border-bottom:1px solid var(--line)}
.brand{font:600 12px/1 ui-monospace,monospace;letter-spacing:.12em;color:var(--muted)}
header nav{display:flex;gap:4px;flex-wrap:wrap}header nav a{color:var(--text);text-decoration:none;padding:10px 12px;border-radius:6px}
header nav a:hover,header nav a:focus{background:var(--card)}.logout{margin-left:auto;display:flex;gap:8px;align-items:center;color:var(--muted)}
main{max-width:1100px;margin:0 auto;padding:20px}h1{font-size:24px;margin:8px 0 16px}h2{font-size:16px;margin:28px 0 8px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em}
a{color:var(--primary)}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:12px;margin-bottom:12px}
.card{background:var(--card);border:1px solid var(--line);border-left:4px solid var(--line);border-radius:8px;padding:14px}
.card.ok{border-left-color:var(--ok)}.card.warn{border-left-color:var(--warn)}.card.bad{border-left-color:var(--bad)}
.card-title{color:var(--muted);font-size:13px}.card-value{font-size:20px;font-weight:600;margin:4px 0}.card-detail{color:var(--muted);font-size:13px}
.table{overflow-x:auto;border:1px solid var(--line);border-radius:8px;background:var(--card)}table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:10px 12px;border-bottom:1px solid var(--line);vertical-align:top}th{font-size:12px;color:var(--muted);text-transform:uppercase}
.badge{display:inline-block;padding:2px 8px;border-radius:4px;font-size:12px;border:1px solid var(--line)}.badge.ok{color:var(--ok)}.badge.warn{color:var(--warn)}.badge.bad{color:var(--bad)}.badge.neutral{color:var(--muted)}
.hint{color:var(--muted)}.error,.bad{color:var(--bad)}.facts{display:grid;grid-template-columns:max-content 1fr;gap:6px 16px}.facts dt{color:var(--muted)}
input{background:var(--bg);color:var(--text);border:1px solid var(--line);border-radius:6px;padding:10px;min-height:44px;font:inherit}
button{background:var(--primary);color:#fff;border:0;border-radius:6px;padding:10px 16px;min-height:44px;font:inherit;cursor:pointer}
button:focus-visible,a:focus-visible,input:focus-visible{outline:2px solid var(--primary);outline-offset:2px}
.login{display:grid;gap:8px;max-width:360px}.search{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.action{display:grid;gap:6px;margin:6px 0}.actions{display:grid;gap:12px;max-width:520px}.pager{display:flex;gap:16px;margin-top:12px}
@media (prefers-reduced-motion: reduce){*{transition:none!important}}
`;
