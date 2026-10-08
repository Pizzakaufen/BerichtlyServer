// Full-Stack-Test: PostgreSQL → Node.js → echtes Nginx mit den ausgelieferten Vorlagen und Snippets.
//
// Voraussetzungen:
//   BERICHTLY_TEST_DATABASE_URL  Testdatenbank (siehe test/helpers.ts)
//   NGINX_BIN                    Nginx-Binary (Linux: meist "nginx"; ohne Angabe wird der Test übersprungen)
//   OPENSSL_BIN                  optional, für den HTTPS-Teil mit Domain (Standard: "openssl" aus PATH)
//
// Betriebsarten: "http" (Entwicklung), "https" (Domain, Zertifikat wie von Let's Encrypt) und "ip" (ohne Domain,
// eigenes Zertifikat aus deploy/tls-selfsigned.sh, Vertrauen über den Pin wie in der App).
//
// Die Vorlagen werden unverändert verwendet; nur absolute Pfade (/etc/nginx/snippets, /etc/letsencrypt,
// /etc/berichtly-server/tls, /var/log/nginx, /var/www/certbot) und die Ports werden für die Testumgebung auf ein
// temporäres Verzeichnis umgeschrieben. Testzertifikate werden zur Laufzeit erzeugt und danach gelöscht – sie liegen
// nie im Repository.

import assert from 'node:assert/strict';
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { checkServerIdentity, type PeerCertificate } from 'node:tls';
import { fileURLToPath } from 'node:url';
import { tlsInfo } from '../../src/security/tls.ts';
import { type Env, newEnv, uuid } from '../helpers.ts';

const NGINX = process.env.NGINX_BIN ?? '';
const OPENSSL = process.env.OPENSSL_BIN ?? 'openssl';
const skip = !process.env.BERICHTLY_TEST_DATABASE_URL ? 'BERICHTLY_TEST_DATABASE_URL nicht gesetzt'
  : !NGINX ? 'NGINX_BIN nicht gesetzt' : false;

type Mode = 'http' | 'https' | 'ip';
const REPO = new URL('../../', import.meta.url);
const hostFor = (mode: Mode) => (mode === 'ip' ? '127.0.0.1' : 'localhost');
const schemeFor = (mode: Mode): 'http' | 'https' => (mode === 'http' ? 'http' : 'https');
const slash = (p: string) => p.replaceAll('\\', '/');

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  raw: string;
  body: any;
}

/**
 * Verbindungsprüfung wie in der App beim Betrieb ohne Domain: Zertifikat muss zur IP passen UND der Pin des
 * öffentlichen Schlüssels muss stimmen.
 */
const pinCheck = (pin: string) => (host: string, cert: PeerCertificate): Error | undefined => {
  const err = checkServerIdentity(host, cert);
  if (err) return err;
  return tlsInfo(cert.raw).pin === pin ? undefined : new Error('Pin stimmt nicht');
};

class Nginx {
  readonly dir: string;
  readonly host: string;
  readonly httpPort: number;
  readonly httpsPort: number;
  readonly ca: Buffer | null;
  readonly pin: string | null;
  private proc: ChildProcess | null = null;

  private constructor(dir: string, host: string, httpPort: number, httpsPort: number, ca: Buffer | null, pin: string | null) {
    this.dir = dir;
    this.host = host;
    this.httpPort = httpPort;
    this.httpsPort = httpsPort;
    this.ca = ca;
    this.pin = pin;
  }

  /** Rendert die Vorlage wie install-nginx.sh bzw. das Docker-Image (envsubst nur für die beiden Variablen). */
  static async start(mode: Mode, upstream: string): Promise<Nginx> {
    const host = hostFor(mode);
    const dir = slash(mkdtempSync(join(tmpdir(), 'berichtly-nginx-')));
    for (const d of ['conf', 'logs', 'temp', 'snippets', 'www', 'certs']) mkdirSync(join(dir, d));
    const httpPort = await freePort();
    const httpsPort = await freePort();
    const local = (text: string) => text
      .replaceAll('/etc/nginx/snippets/', `${dir}/snippets/`)
      .replaceAll(`/etc/letsencrypt/live/${host}/`, `${dir}/certs/`)
      .replaceAll('/etc/berichtly-server/tls/', `${dir}/certs/`)
      .replaceAll('/var/log/nginx/', `${dir}/logs/`)
      .replaceAll('/var/www/certbot', `${dir}/www`);
    for (const name of ['berichtly-http-context.conf', 'berichtly-api.conf', 'berichtly-proxy.conf']) {
      writeFileSync(join(dir, 'snippets', name), local(readFileSync(new URL(`deploy/nginx/snippets/${name}`, REPO), 'utf8')));
    }
    const template = readFileSync(new URL(`deploy/nginx/templates/berichtly-${mode}.conf.template`, REPO), 'utf8');
    const site = local(template.replaceAll('${BERICHTLY_DOMAIN}', host).replaceAll('${BERICHTLY_UPSTREAM}', upstream))
      .replace(/listen 80;/g, `listen 127.0.0.1:${httpPort};`)
      .replace(/listen 443 ssl( default_server)?;/g, `listen 127.0.0.1:${httpsPort} ssl$1;`)
      .replace(`return 308 https://${host}$request_uri;`, `return 308 https://${host}:${httpsPort}$request_uri;`);
    assert.ok(!site.includes('${'), 'nicht ersetzte Vorlagenvariable');
    writeFileSync(join(dir, 'conf', 'berichtly.conf'), site);

    let ca: Buffer | null = null;
    let pin: string | null = null;
    if (mode === 'https') {
      execFileSync(OPENSSL, ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', '1',
        '-subj', `/CN=${host}`, '-addext', `subjectAltName=DNS:${host}`,
        '-keyout', join(dir, 'certs', 'privkey.pem'), '-out', join(dir, 'certs', 'fullchain.pem')], { stdio: 'ignore' });
      ca = readFileSync(join(dir, 'certs', 'fullchain.pem'));
    } else if (mode === 'ip') {
      // Das ausgelieferte Skript erzeugt Schlüssel und Zertifikat (wie bei der Installation).
      execFileSync('sh', [fileURLToPath(new URL('deploy/tls-selfsigned.sh', REPO)), host, `${dir}/certs`],
        { stdio: 'ignore', env: { ...process.env, MSYS2_ARG_CONV_EXCL: '*' } });
      ca = readFileSync(join(dir, 'certs', 'server.crt'));
      pin = tlsInfo(ca).pin;
    }
    writeFileSync(join(dir, 'conf', 'nginx.conf'), `
worker_processes 1;
daemon off;
pid ${dir}/logs/nginx.pid;
error_log ${dir}/logs/error.log warn;
events { worker_connections 256; }
http {
    default_type application/octet-stream;
    client_body_temp_path ${dir}/temp/body;
    proxy_temp_path ${dir}/temp/proxy;
    fastcgi_temp_path ${dir}/temp/fastcgi;
    uwsgi_temp_path ${dir}/temp/uwsgi;
    scgi_temp_path ${dir}/temp/scgi;
    include ${dir}/conf/berichtly.conf;
}
`);
    const args = ['-p', `${dir}/`, '-c', `${dir}/conf/nginx.conf`];
    // Syntaxprüfung der ausgelieferten Konfiguration (wie install-nginx.sh).
    execFileSync(NGINX, [...args, '-t'], { stdio: 'pipe' });
    const n = new Nginx(dir, host, httpPort, httpsPort, ca, pin);
    n.proc = spawn(NGINX, args, { stdio: 'ignore' });
    for (let i = 0; i < 50; i++) {
      try {
        await n.request('http', 'GET', '/nginx-bereit'); // beantwortet Nginx selbst, ohne Node.js zu belasten
        return n;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    throw new Error('Nginx ist nicht gestartet: ' + readFileSync(join(dir, 'logs', 'error.log'), 'utf8'));
  }

  /** TLS-Optionen wie in der App: bei IP-Betrieb ohne SNI, mit Pin-Prüfung. */
  tlsOptions(pin = this.pin) {
    return {
      ca: this.ca ?? undefined,
      servername: this.pin ? undefined : this.host,
      ...(pin ? { checkServerIdentity: pinCheck(pin) } : {}),
    };
  }

  request(scheme: 'http' | 'https', method: string, path: string, o: { token?: string; body?: unknown;
    headers?: Record<string, string>; pin?: string } = {}): Promise<Reply> {
    const headers: Record<string, string> = { ...o.headers };
    let payload: Buffer | undefined;
    if (o.body !== undefined) {
      payload = Buffer.from(typeof o.body === 'string' ? o.body : JSON.stringify(o.body));
      headers['Content-Type'] ??= 'application/json';
      headers['Content-Length'] = String(payload.length);
    }
    if (o.token) headers.Authorization = `Bearer ${o.token}`;
    const lib = scheme === 'https' ? https : http;
    const port = scheme === 'https' ? this.httpsPort : this.httpPort;
    return new Promise((resolve, reject) => {
      const req = lib.request({
        host: '127.0.0.1', port, method, path, headers: { Host: this.host, ...headers }, agent: false,
        ...(scheme === 'https' ? this.tlsOptions(o.pin ?? this.pin) : {}),
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          const json = (res.headers['content-type'] ?? '').startsWith('application/json') && raw ? JSON.parse(raw) : undefined;
          resolve({ status: res.statusCode ?? 0, headers: res.headers, raw, body: json });
        });
      });
      req.on('error', reject);
      req.end(payload);
    });
  }

  accessLog() {
    return readFileSync(join(this.dir, 'logs', 'access.log'), 'utf8');
  }

  async stop() {
    try {
      execFileSync(NGINX, ['-p', `${this.dir}/`, '-c', `${this.dir}/conf/nginx.conf`, '-s', 'stop'], { stdio: 'ignore' });
    } catch {
      this.proc?.kill();
    }
    if (this.proc && this.proc.exitCode === null) {
      await new Promise((r) => {
        const t = setTimeout(() => { this.proc?.kill(); r(null); }, 5000);
        this.proc!.once('exit', () => { clearTimeout(t); r(null); });
      });
    }
    rmSync(this.dir, { recursive: true, force: true }); // inkl. der Testzertifikate
  }
}

const expectStatus = (r: Reply, status: number) => assert.equal(r.status, status, `HTTP ${status} erwartet, ${r.status}: ${r.raw}`);

for (const mode of ['http', 'https', 'ip'] as const) {
  const scheme = schemeFor(mode);
  describe(`API über Nginx (${mode})`, { skip }, () => {
    let env: Env;
    let nginx: Nginx;
    const logs: string[] = [];
    const call = (method: string, path: string, o: Parameters<Nginx['request']>[3] = {}) => nginx.request(scheme, method, path, o);

    before(async () => {
      env = await newEnv({ shared: true, logLines: logs, overrides: { TRUST_PROXY: 'true', RATE_LIMIT_API_PER_MINUTE: '100000' } });
      const upstream = new URL(env.base).host;
      nginx = await Nginx.start(mode, upstream);
    });
    after(async () => {
      await nginx?.stop();
    });

    test('Health, Request-ID und Sicherheits-Header', async () => {
      const r = await call('GET', '/api/v1/health', { headers: { 'X-Request-ID': 'nginx-test-0001' } });
      expectStatus(r, 200);
      assert.equal(r.body.data.components.database, 'up');
      assert.equal(r.headers['x-request-id'], 'nginx-test-0001'); // gleiche ID in Nginx- und Server-Log
      assert.equal(r.headers['x-content-type-options'], 'nosniff');
      assert.equal(r.headers['cache-control'], 'no-store');
      assert.equal(r.headers.server, 'nginx'); // ohne Versionsnummer (server_tokens off)
      if (scheme === 'https') {
        assert.equal(r.headers['strict-transport-security'], 'max-age=31536000'); // genau einmal, von Nginx
      } else {
        assert.equal(r.headers['strict-transport-security'], undefined);
      }
      const generated = await call('GET', '/api/v1/health/live', { headers: { 'X-Request-ID': '<script>' } });
      assert.match(String(generated.headers['x-request-id']), /^[0-9a-f]{32}$/); // von Nginx erzeugt
      assert.ok(nginx.accessLog().includes('"request_id":"nginx-test-0001"'));
    });

    test('alle Methoden, Bodies, Query und Authorization werden durchgereicht', async () => {
      const email = `nginx-${uuid()}@example.org`;
      const device = uuid();
      const reg = await call('POST', '/api/v1/auth/register', { body: { email, password: 'korrekt-Pferd-Batterie-42', device: { id: device, name: 'Pixel' } } });
      expectStatus(reg, 201);
      const login = await call('POST', '/api/v1/auth/login', { body: { email, password: 'korrekt-Pferd-Batterie-42', device: { id: device } } });
      expectStatus(login, 200);
      const token: string = login.body.data.tokens.accessToken;

      const noAuth = await call('GET', '/api/v1/account');
      expectStatus(noAuth, 401);
      assert.equal(noAuth.body.error.code, 'UNAUTHORIZED');
      assert.ok(noAuth.headers['www-authenticate']);
      expectStatus(await call('GET', '/api/v1/account', { token }), 200);

      const created = await call('POST', '/api/v1/daily-reports', { token, body: { date: '2026-10-05', text: 'Über Nginx erfasst' } });
      expectStatus(created, 201);
      const id = created.body.data.id;
      const put = await call('PUT', `/api/v1/daily-reports/${id}`, { token, body: { version: 1, date: '2026-10-05', text: 'Über Nginx geändert' } });
      expectStatus(put, 200);
      assert.equal(put.body.data.version, 2);
      const conflict = await call('PUT', `/api/v1/daily-reports/${id}`, { token, body: { version: 1, date: '2026-10-05', text: 'veraltet' } });
      expectStatus(conflict, 409);
      assert.equal(conflict.body.error.conflict.reason, 'VERSION_MISMATCH');
      const patch = await call('PATCH', `/api/v1/devices/${device}`, { token, body: { name: 'Mein Handy' } });
      expectStatus(patch, 200);
      assert.equal(patch.body.data.name, 'Mein Handy');
      const list = await call('GET', '/api/v1/daily-reports?from=2026-10-01&to=2026-10-31&sort=date_asc', { token });
      expectStatus(list, 200);
      assert.equal(list.body.meta.total, 1);
      expectStatus(await call('DELETE', `/api/v1/daily-reports/${id}?version=2`, { token }), 204);
      expectStatus(await call('GET', `/api/v1/daily-reports/${id}`, { token }), 404);

      const sync = await call('POST', '/api/v1/sync', { token, body: { cursor: '0', changes: [{ operationId: uuid(), type: 'DAILY_REPORT',
        operation: 'UPSERT', id: uuid(), data: { date: '2026-10-06', text: 'per Sync' } }] } });
      expectStatus(sync, 200);
      assert.equal(sync.body.data.push.results[0].status, 'APPLIED');
      const complete = await call('POST', '/api/v1/sync/complete', { token, body: { result: 'SUCCESS', cursor: sync.body.data.pull.nextCursor } });
      expectStatus(complete, 200);
      assert.equal(complete.body.data.syncStatus, 'SUCCESS');
      expectStatus(await call('GET', '/api/v1/sync/status', { token }), 200);
      expectStatus(await call('GET', '/api/v1/weeks/2026/41', { token }), 200);

      // Fehler von Node.js kommen unverändert an (Status, Fehlerformat).
      const invalid = await call('POST', '/api/v1/daily-reports', { token, body: { date: 'kaputt', text: 'x' } });
      expectStatus(invalid, 422);
      assert.equal(invalid.body.error.code, 'VALIDATION_FAILED');
      const wrongType = await call('POST', '/api/v1/daily-reports', { token, body: 'x', headers: { 'Content-Type': 'text/plain' } });
      expectStatus(wrongType, 415);
      const method = await call('DELETE', '/api/v1/health');
      expectStatus(method, 405);

      expectStatus(await call('POST', '/api/v1/auth/logout', { token }), 204);
      expectStatus(await call('GET', '/api/v1/account', { token }), 401);
    });

    test('X-Forwarded-Proto und X-Forwarded-For kommen beim Server an', async () => {
      logs.length = 0;
      await call('GET', '/api/v1/health/ready');
      const line = logs.map((l) => JSON.parse(l)).find((l) => l.msg === 'request' && l.path === '/api/v1/health/ready');
      assert.ok(line, 'Request-Log fehlt');
      assert.equal(line.proto, scheme); // Node.js kennt das Protokoll zwischen App und Nginx
    });

    test('Client kann seine IP nicht fälschen (Rate Limit pro echter Adresse)', async () => {
      const own = await newEnv({ overrides: { TRUST_PROXY: 'true', RATE_LIMIT_API_PER_MINUTE: '3' } });
      const n = await Nginx.start(mode, new URL(own.base).host);
      try {
        for (let i = 0; i < 3; i++) {
          expectStatus(await n.request(scheme, 'GET', '/api/v1/health/live', { headers: { 'X-Forwarded-For': `203.0.113.${i}` } }), 200);
        }
        const limited = await n.request(scheme, 'GET', '/api/v1/health/live', { headers: { 'X-Forwarded-For': '203.0.113.99' } });
        expectStatus(limited, 429); // trotz wechselnder gefälschter Adressen: Node.js zählt die echte Client-IP
        assert.equal(limited.body.error.code, 'RATE_LIMITED');
        assert.ok(limited.headers['retry-after']);
      } finally {
        await n.stop();
        await own.close();
      }
    });

    test('Größenlimit, gesperrte Bereiche und Fehlerformat von Nginx', async () => {
      const big = await call('POST', '/api/v1/auth/login', { body: JSON.stringify({ email: 'x@example.org', password: 'x'.repeat(2 * 1024 * 1024) }) });
      expectStatus(big, 413);
      assert.equal(big.body.error.code, 'PAYLOAD_TOO_LARGE');
      assert.ok(big.body.error.requestId);

      for (const path of ['/', '/index.html', '/internal/status', '/.env', '/api']) {
        const r = await call('GET', path, { headers: { Authorization: 'Bearer test-status-token-0123456789abcdefghij' } });
        expectStatus(r, 404);
        if (path !== '/internal/status') assert.equal(r.body?.error?.code, 'NOT_FOUND', `${path}: ${r.headers['content-type']} ${r.raw}`);
      }
      assert.ok(!nginx.accessLog().includes('Bearer'), 'Token im Zugriffslog');
    });

    if (scheme === 'https') {
      test('HTTP wird auf HTTPS umgeleitet (Methode bleibt erhalten)', async () => {
        const r = await nginx.request('http', 'POST', '/api/v1/auth/login?x=1', { body: { email: 'a@example.org', password: 'x' } });
        expectStatus(r, 308);
        assert.equal(r.headers.location, `https://${nginx.host}:${nginx.httpsPort}/api/v1/auth/login?x=1`);
        if (mode === 'https') {
          const acme = await nginx.request('http', 'GET', '/.well-known/acme-challenge/nicht-vorhanden');
          expectStatus(acme, 404); // Webroot für Let's Encrypt wird über HTTP ausgeliefert, nicht umgeleitet
        }
      });

      test('nur TLS 1.2 und 1.3', async () => {
        await assert.rejects(new Promise((resolve, reject) => {
          const req = https.request({ host: '127.0.0.1', port: nginx.httpsPort, path: '/api/v1/health', ...nginx.tlsOptions(),
            maxVersion: 'TLSv1.1', minVersion: 'TLSv1', agent: false }, resolve);
          req.on('error', reject);
          req.end();
        }));
        const tls12 = await new Promise<number>((resolve, reject) => {
          const req = https.request({ host: '127.0.0.1', port: nginx.httpsPort, path: '/api/v1/health/live', ...nginx.tlsOptions(),
            headers: { Host: nginx.host }, maxVersion: 'TLSv1.2', agent: false }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
          req.on('error', reject);
          req.end();
        });
        assert.equal(tls12, 200);
      });
    }

    if (mode === 'ip') {
      test('ohne Domain: Vertrauen nur über den Pin, falscher Pin wird abgelehnt', async () => {
        assert.match(nginx.pin!, /^sha256\/[A-Za-z0-9+/]{43}=$/);
        // Mit richtigem Pin (oben in allen Tests verwendet) klappt die Verbindung, mit fremdem nicht.
        const wrongPin = 'sha256/' + Buffer.alloc(32, 7).toString('base64');
        await assert.rejects(nginx.request('https', 'GET', '/api/v1/health/live', { pin: wrongPin }), /Pin stimmt nicht/);
        // Ohne eigenes Vertrauen (wie ein Browser) wird das eigene Zertifikat nicht akzeptiert.
        await assert.rejects(new Promise((resolve, reject) => {
          const req = https.request({ host: '127.0.0.1', port: nginx.httpsPort, path: '/api/v1/health/live', agent: false }, resolve);
          req.on('error', reject);
          req.end();
        }));
      });
    }
  });
}
