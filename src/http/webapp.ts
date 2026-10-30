// Weboberfläche für Konten (seit 2.2) unter /app – statische Dateien aus web/, nur mit WEB_APP_ENABLED=true.
//
// - Ausgeliefert werden ausschließlich Dateien, die beim Start in web/ gefunden wurden (feste Liste, kein Pfad aus
//   der Anfrage erreicht das Dateisystem); erlaubte Typen: HTML, CSS, JavaScript, Lizenztexte.
// - Strenge Content-Security-Policy: nur eigene Skripte und Stile, Verbindungen nur zur eigenen API, keine Frames.
// - Die Seite enthält keine Daten; alles kommt nach der Anmeldung über /api/v1 (gleiche Rechte wie die App).

import type { FastifyInstance } from 'fastify';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '': 'text/plain; charset=utf-8', // LICENSE
};

export const WEB_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
  "form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

/** Liest web/ einmalig ein: URL-Pfad → Inhalt und Typ. */
export function loadWebFiles(dir: string): Map<string, { body: Buffer; type: string }> {
  const files = new Map<string, { body: Buffer; type: string }>();
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else {
        const type = TYPES[extname(name)];
        if (type === undefined) continue;
        files.set('/app/' + relative(dir, full).split(sep).join('/'), { body: readFileSync(full), type });
      }
    }
  };
  walk(dir);
  return files;
}

export function webAppRoutes(app: FastifyInstance, dir: string) {
  const files = loadWebFiles(dir);
  const index = files.get('/app/index.html');
  if (!index) throw new Error(`Weboberfläche: ${dir}/index.html fehlt`);

  const send = (path: string, reply: import('fastify').FastifyReply) => {
    const f = path === '/app' || path === '/app/' ? index : files.get(path);
    if (!f) return reply.code(404).type('text/plain; charset=utf-8').send('Nicht gefunden');
    reply.header('Content-Security-Policy', WEB_CSP);
    reply.header('X-Robots-Tag', 'noindex, nofollow');
    // HTML immer frisch, Module und Stile kurz zwischenspeichern.
    reply.header('Cache-Control', f === index ? 'no-cache' : 'public, max-age=300');
    return reply.code(200).type(f.type).send(f.body);
  };
  app.get('/app', (req, reply) => send('/app', reply));
  app.get('/app/*', (req, reply) => send(req.url.split('?')[0], reply));
}
