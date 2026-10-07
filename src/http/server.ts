// HTTP-Schicht (Fastify). Node.js lauscht nur intern (127.0.0.1 bzw. im Docker-Netz); öffentlich ist allein Nginx.
//
// Reihenfolge je Anfrage (wie in 1.1):
//   Request-ID → Sicherheits-Header → CORS → allgemeines Rate Limit → Routing
//   → Routen-Rate-Limit → Authentifizierung → Body lesen → Handler → einheitliche Fehlerantwort → Log.

import { randomUUID, timingSafeEqual } from 'node:crypto';
import { statfs } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import Fastify, {
  type FastifyInstance, type FastifyReply, type FastifyRequest, type HTTPMethods, type RouteHandlerMethod,
} from 'fastify';
import type { Config } from '../config/config.ts';
import { ApiError, Codes, unauthorized } from '../domain/errors.ts';
import { formatTime } from '../domain/date.ts';
import type { Database } from '../db/pool.ts';
import { latestSchemaVersion, schemaVersion } from '../db/migrate.ts';
import type { AccountService, DeviceService, ProfileService } from '../services/account.ts';
import type { AuthService } from '../services/auth.ts';
import type { ReportService } from '../services/reports.ts';
import type { SyncService } from '../services/sync.ts';
import type { Logger } from '../util/logger.ts';
import { Limiter, Metrics } from './limiter.ts';
import { JSON_TYPE, sendData, sendError } from './respond.ts';
import { routesV1 } from './routes-v1.ts';

export interface Deps {
  config: Config;
  db: Database;
  log: Logger;
  auth: AuthService;
  account: AccountService;
  profiles: ProfileService;
  reports: ReportService;
  sync: SyncService;
  devices: DeviceService;
  version: string;
  openapi: string | null; // Inhalt von api/openapi.yaml (nur wenn API_DOCS_ENABLED)
}

export interface RouteOptions {
  auth?: boolean;
  limiter?: Limiter;
}

type Handler = (req: FastifyRequest, reply: FastifyReply) => unknown;

export interface RouteHelper {
  deps: Deps;
  limiters: { login: Limiter; account: Limiter; register: Limiter; refresh: Limiter };
  system: { health: Handler; live: Handler; ready: Handler };
  route(method: HTTPMethods, url: string, o: RouteOptions, handler: Handler): void;
  /** false = abgelehnt (429 bereits gesendet). */
  limit(l: Limiter, key: string, reply: FastifyReply): boolean;
}

const REQUEST_ID_HEADER = 'x-request-id';
const validRequestId = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(id);

export interface Server {
  app: FastifyInstance;
  metrics: Metrics;
  /** Alle registrierten Routen (für 405 und den OpenAPI-Vollständigkeitstest). */
  routes: { method: string; url: string }[];
  /** Kontrollierter Shutdown: keine neuen Anfragen (503), laufende werden beendet. */
  close(timeoutMs: number): Promise<boolean>;
}

export async function buildServer(d: Deps): Promise<Server> {
  const cfg = d.config;
  const metrics = new Metrics();
  let closing = false;

  const app = Fastify({
    logger: false, // eigenes strukturiertes Logging (ohne Header, Query-Werte, Bodies)
    bodyLimit: cfg.server.maxBodyBytes,
    // Hinter Nginx: genau ein vertrauenswürdiger Proxy. Client-IP = letzter Eintrag in X-Forwarded-For.
    trustProxy: cfg.server.trustProxy ? (_addr: string, hop: number) => hop < 1 : false,
    genReqId: (req) => {
      const id = req.headers[REQUEST_ID_HEADER];
      return validRequestId(id) ? id : randomUUID();
    },
    // Länger als keepalive_timeout von Nginx-Upstreams (60 s), damit Nginx Verbindungen zuerst schließt.
    keepAliveTimeout: 75_000,
    requestTimeout: 60_000,
    connectionTimeout: 0,
    return503OnClosing: false, // eigene 503-Antwort im einheitlichen Format (siehe onRequest)
    forceCloseConnections: 'idle',
    onProtoPoisoning: 'error',
    onConstructorPoisoning: 'error',
    exposeHeadRoutes: true,
  });

  // Bodies werden roh gelesen; Content-Type und JSON prüft der Handler (415 nur dort, wo ein Body erwartet wird).
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  // Bekannte Routen für 405 (falsche Methode) statt 404.
  const routes: { method: string; url: string; re: RegExp }[] = [];
  app.addHook('onRoute', (opts) => {
    const pattern = '^' + opts.url.split('/').map((s) => (s.startsWith(':') ? '[^/]+' : escapeRe(s))).join('/') + '$';
    for (const m of [opts.method].flat()) routes.push({ method: m, url: opts.url, re: new RegExp(pattern) });
  });

  app.decorateRequest('principal', null);
  app.decorateRequest('log2', null as unknown as Logger);
  app.decorateRequest('startedAt', 0n);

  const apiLimiter = new Limiter(cfg.rateLimit.apiPerMinute);
  const corsOrigins = cfg.corsAllowedOrigins;
  const corsWildcard = corsOrigins.includes('*');

  const rateLimited = (reply: FastifyReply, retryAfter: number) => {
    reply.header('Retry-After', String(retryAfter));
    return sendError(reply, new ApiError(429, Codes.RateLimited, 'Zu viele Anfragen. Bitte kurz warten und erneut versuchen.'));
  };

  app.addHook('onRequest', async (req, reply) => {
    req.startedAt = process.hrtime.bigint();
    req.log2 = d.log.child({ request_id: req.id });
    reply.header('X-Request-ID', req.id);

    // Sicherheits-Header. HSTS nur, wenn der vertrauenswürdige Proxy HTTPS meldet (Nginx setzt es zusätzlich).
    const path = urlPath(req.url);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Cross-Origin-Resource-Policy', 'same-origin');
    if (path.startsWith('/api/v') || path.startsWith('/internal/')) {
      reply.header('Cache-Control', 'no-store');
      reply.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    }
    if (cfg.server.trustProxy && req.headers['x-forwarded-proto'] === 'https') {
      reply.header('Strict-Transport-Security', 'max-age=31536000');
    }

    if (closing) {
      reply.header('Connection', 'close');
      reply.header('Retry-After', '5');
      return sendError(reply, new ApiError(503, Codes.ServiceUnavailable, 'Der Server wird gerade neu gestartet. Bitte gleich erneut versuchen.'));
    }

    // CORS nur für ausdrücklich konfigurierte Origins (die Android-App benötigt kein CORS).
    const origin = req.headers.origin;
    if (corsOrigins.length > 0 && origin && (corsWildcard || corsOrigins.includes(origin))) {
      reply.header('Access-Control-Allow-Origin', origin);
      reply.header('Vary', 'Origin');
      reply.header('Access-Control-Expose-Headers', 'X-Request-ID');
      if (req.method === 'OPTIONS' && req.headers['access-control-request-method']) {
        reply.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE');
        reply.header('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Request-ID');
        reply.header('Access-Control-Max-Age', '600');
        return reply.code(204).send();
      }
    }

    const res = apiLimiter.allow(req.ip);
    if (!res.ok) return rateLimited(reply, res.retryAfter);
  });

  // Während des Shutdowns wird keine Verbindung wiederverwendet (auch nicht nach laufenden Anfragen).
  app.addHook('onSend', async (_req, reply) => {
    if (closing) reply.header('Connection', 'close');
  });

  app.addHook('onResponse', async (req, reply) => {
    metrics.record(reply.statusCode);
    const path = urlPath(req.url);
    if (path === '/api/v1/health/live') return;
    const fields: Record<string, unknown> = {
      method: req.method, path, status: reply.statusCode, proto: req.protocol,
      duration_ms: Number((process.hrtime.bigint() - req.startedAt) / 1_000_000n),
    };
    if (req.principal) fields.user_id = req.principal.userId;
    (req.log2 ?? d.log).info('request', fields);
  });

  app.setErrorHandler((err: unknown, req, reply) => {
    if (err instanceof ApiError) return sendError(reply, err);
    const e = err as { code?: string; statusCode?: number; message?: string };
    if (e.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return sendError(reply, new ApiError(413, Codes.PayloadTooLarge, 'Die Anfrage ist zu groß.'));
    }
    if (typeof e.code === 'string' && e.code.startsWith('FST_') && e.statusCode && e.statusCode < 500) {
      return sendError(reply, new ApiError(400, Codes.InvalidRequestBody,
        'Der Request-Body ist kein gültiges JSON oder hat eine falsche Struktur.'));
    }
    if (isDatabaseUnavailable(err)) {
      (req.log2 ?? d.log).error('Datenbank nicht erreichbar', { method: req.method, path: urlPath(req.url), error: e.message });
      reply.header('Retry-After', '5');
      return sendError(reply, new ApiError(503, Codes.ServiceUnavailable,
        'Der Dienst ist vorübergehend nicht verfügbar. Bitte später erneut versuchen.'));
    }
    (req.log2 ?? d.log).error('Unbehandelter Fehler', { method: req.method, path: urlPath(req.url), error: e.message });
    metrics.unhandled++;
    return sendError(reply, new ApiError(500, Codes.InternalError, 'Interner Serverfehler. Bitte später erneut versuchen.'));
  });

  app.setNotFoundHandler((req, reply) => {
    const path = urlPath(req.url);
    const allowed = [...new Set(routes.filter((r) => r.re.test(path)).map((r) => r.method))];
    if (allowed.length > 0) {
      reply.header('Allow', allowed.join(', '));
      return sendError(reply, new ApiError(405, Codes.MethodNotAllowed, 'HTTP-Methode nicht erlaubt.'));
    }
    return sendError(reply, new ApiError(404, Codes.NotFound, 'Der angeforderte Endpunkt existiert nicht.'));
  });

  const authenticate = async (req: FastifyRequest, reply: FastifyReply) => {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const p = token ? await d.auth.authenticate(token) : null;
    if (!p) {
      reply.header('WWW-Authenticate', 'Bearer realm="berichtly"');
      throw unauthorized();
    }
    req.principal = p;
  };

  const helper: RouteHelper = {
    deps: d,
    limiters: {
      login: new Limiter(cfg.rateLimit.loginPerMinute),
      account: new Limiter(cfg.rateLimit.loginPerAccountPerMinute),
      register: new Limiter(cfg.rateLimit.registerPerMinute),
      refresh: new Limiter(cfg.rateLimit.refreshPerMinute),
    },
    system: systemHandlers(d),
    limit(l, key, reply) {
      const res = l.allow(key);
      if (res.ok) return true;
      rateLimited(reply, res.retryAfter);
      return false;
    },
    route(method, url, o, handler) {
      const onRequest: ((req: FastifyRequest, reply: FastifyReply) => Promise<unknown>)[] = [];
      if (o.limiter) {
        const l = o.limiter;
        onRequest.push(async (req, reply) => {
          const res = l.allow(req.ip);
          if (!res.ok) return rateLimited(reply, res.retryAfter);
        });
      }
      if (o.auth) onRequest.push(authenticate);
      app.route({ method, url, onRequest, handler: handler as RouteHandlerMethod });
    },
  };

  routesV1(helper, '/api/v1');

  // Interner Status (nur mit INTERNAL_STATUS_TOKEN; über Nginx gesperrt) und API-Dokumentation (optional)
  if (cfg.status.internalToken) app.get('/internal/status', internalStatus(d, metrics));
  if (cfg.apiDocs && d.openapi) {
    const spec = d.openapi;
    app.get('/api/openapi.yaml', (_req, reply) => reply.type('application/yaml; charset=utf-8').send(spec));
    app.get('/api/docs', (_req, reply) => reply.type('text/html; charset=utf-8').send(SWAGGER_PAGE));
  }

  await app.ready();

  return {
    app,
    metrics,
    routes: routes.map(({ method, url }) => ({ method, url })),
    async close(timeoutMs: number) {
      closing = true;
      // Ruhende Keep-Alive-Verbindungen sofort schließen, auch solche, die erst nach laufenden Anfragen frei werden.
      const sweep = setInterval(() => app.server.closeIdleConnections(), 100);
      let timer: NodeJS.Timeout | undefined;
      const timedOut = new Promise<boolean>((resolve) => {
        timer = setTimeout(() => {
          app.server.closeAllConnections();
          resolve(false);
        }, timeoutMs);
      });
      const done = app.close().then(() => true);
      const ok = await Promise.race([done, timedOut]);
      clearTimeout(timer);
      clearInterval(sweep);
      return ok;
    },
  };
}

// ---------------------------------------------------------------------------
// System: Health, Readiness, interner Status, Dokumentation
// ---------------------------------------------------------------------------

function systemHandlers(d: Deps) {
  return {
    /** Öffentlicher Health-Check: nur Zustände – keine Versionen, Hostnamen oder Fehlermeldungen. */
    async health(req: FastifyRequest, reply: FastifyReply) {
      const up = await d.db.ping(3000);
      if (!up) req.log2.warn('Health-Check: Datenbank nicht erreichbar');
      sendData(reply, up ? 200 : 503, {
        status: up ? 'ok' : 'unavailable',
        components: { api: 'up', database: up ? 'up' : 'down' },
      });
    },
    /** Nur Prozess (ohne Datenbank). */
    live(_req: FastifyRequest, reply: FastifyReply) {
      sendData(reply, 200, { status: 'ok', components: { api: 'up' } });
    },
    /** Bereitschaft: Datenbank erreichbar und Schema aktuell (Docker-Healthcheck, Monitoring). */
    async ready(_req: FastifyRequest, reply: FastifyReply) {
      let database = 'down';
      let schema = 'unknown';
      if (await d.db.ping(3000)) {
        database = 'up';
        try {
          schema = (await schemaVersion(d.db)) >= latestSchemaVersion() ? 'current' : 'outdated';
        } catch {
          schema = 'unknown';
        }
      }
      const ok = database === 'up' && schema === 'current';
      sendData(reply, ok ? 200 : 503, { status: ok ? 'ready' : 'not_ready', components: { api: 'up', database, schema } });
    },
  };
}

function internalStatus(d: Deps, metrics: Metrics) {
  const expected = Buffer.from(d.config.status.internalToken);
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const header = req.headers.authorization ?? '';
    const given = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '');
    // Konstante Vergleichszeit; ohne gültiges Token wie ein unbekannter Endpunkt.
    const ok = given.length === expected.length && timingSafeEqual(given, expected);
    if (!ok) throw new ApiError(404, Codes.NotFound, 'Der angeforderte Endpunkt existiert nicht.');

    const db: Record<string, unknown> = { state: 'DOWN' };
    const start = performance.now();
    if (await d.db.ping(3000)) {
      db.state = 'UP';
      db.latencyMs = Math.round(performance.now() - start);
      try {
        db.schemaVersion = await schemaVersion(d.db);
      } catch { /* bleibt leer */ }
    }
    const pool = d.db.pool;
    db.poolTotal = pool.totalCount;
    db.poolIdle = pool.idleCount;
    db.poolInUse = pool.totalCount - pool.idleCount;
    db.poolWaiting = pool.waitingCount;
    db.poolMax = d.config.database.maxConns;

    const mem = process.memoryUsage();
    const free = await diskFreeMb('.');
    const minFree = d.config.status.minFreeDiskMb;
    const resources = {
      state: free >= 0 && free < minFree ? 'DEGRADED' : 'UP',
      heapAllocMb: Math.floor(mem.heapUsed / 2 ** 20),
      sysMemoryMb: Math.floor(mem.rss / 2 ** 20),
      diskFreeMb: free,
      diskMinFreeMb: minFree,
      cpus: availableParallelism(),
      nodeVersion: process.version,
    };
    const overall = db.state === 'DOWN' ? 'DOWN' : resources.state !== 'UP' ? 'DEGRADED' : 'UP';
    sendData(reply, overall === 'DOWN' ? 503 : 200, {
      state: overall,
      version: d.version,
      environment: d.config.env,
      startedAt: formatTime(metrics.started),
      uptimeSeconds: Math.floor((Date.now() - metrics.started.getTime()) / 1000),
      database: db,
      resources,
      metrics: metrics.snapshot(),
    });
  };
}

async function diskFreeMb(path: string): Promise<number> {
  try {
    const s = await statfs(path);
    return Math.floor((s.bavail * s.bsize) / 2 ** 20);
  } catch {
    return -1;
  }
}

/** Verbindungsfehler zur Datenbank → 503 statt 500 (vorübergehend, Client darf wiederholen). */
function isDatabaseUnavailable(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  if (typeof e?.code === 'string') {
    if (['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENOTFOUND', 'EAI_AGAIN'].includes(e.code)) return true;
    if (/^(08|57P0)/.test(e.code)) return true; // connection_exception, admin_shutdown/crash_shutdown/cannot_connect_now
  }
  const msg = e?.message ?? '';
  return msg.includes('timeout exceeded when trying to connect') || msg.includes('Connection terminated');
}

const urlPath = (url: string) => {
  const i = url.indexOf('?');
  return i < 0 ? url : url.slice(0, i);
};

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Swagger UI lädt der Browser des Entwicklers von unpkg.com; in Produktion ist die Doku standardmäßig aus.
const SWAGGER_PAGE = `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <title>Berichtly Server API</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5.17.14/swagger-ui.css">
</head>
<body>
<div id="swagger-ui"></div>
<script src="https://unpkg.com/swagger-ui-dist@5.17.14/swagger-ui-bundle.js" crossorigin="anonymous"></script>
<script>window.onload = () => { window.ui = SwaggerUIBundle({ url: "/api/openapi.yaml", dom_id: "#swagger-ui" }); };</script>
</body>
</html>`;

export { JSON_TYPE };
