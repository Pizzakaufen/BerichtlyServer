// Rechtsseiten (seit 2.1): Impressum und Datenschutzhinweise, die der Betreiber selbst als Textdatei verfasst
// (LEGAL_IMPRINT_FILE, LEGAL_PRIVACY_FILE). Der Server erfindet keine Inhalte: Ohne Datei gibt es keine Seite (404),
// und GET /api/v1/legal meldet null. Der Text wird vollständig escaped (kein HTML, keine Skripte).
//
// Format der Textdatei: Absätze durch Leerzeilen getrennt, Zeilen mit "# " am Anfang werden Zwischenüberschriften.

import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../config/config.ts';
import type { Logger } from '../util/logger.ts';
import { esc } from './admin.ts';

export interface LegalDoc { title: string; path: string; html: string }
export interface LegalDocs { imprint: LegalDoc | null; privacy: LegalDoc | null }

/** Wandelt den Klartext des Betreibers in sicheres HTML um. */
export function renderLegalText(text: string): string {
  return text.replace(/\r\n?/g, '\n').split(/\n\s*\n/).map((block) => block.trim()).filter(Boolean).map((block) =>
    block.startsWith('# ') ? `<h2>${esc(block.slice(2).trim())}</h2>`
      : `<p>${block.split('\n').map((line) => esc(line)).join('<br>')}</p>`).join('\n');
}

export function loadLegalDocs(cfg: Config['legal'], log: Logger): LegalDocs {
  const load = (file: string | undefined, title: string, path: string): LegalDoc | null => {
    if (!file) return null;
    try {
      const text = readFileSync(file, 'utf8');
      if (!text.trim()) throw new Error('Datei ist leer');
      return { title, path, html: renderLegalText(text) };
    } catch (e) {
      log.warn('Rechtsseite nicht lesbar – wird nicht angezeigt', { title, error: (e as Error).message });
      return null;
    }
  };
  return {
    imprint: load(cfg.imprintFile, 'Impressum', '/legal/impressum'),
    privacy: load(cfg.privacyFile, 'Datenschutzhinweise', '/legal/datenschutz'),
  };
}

export function legalLinks(docs: LegalDocs) {
  return { imprintUrl: docs.imprint?.path ?? null, privacyUrl: docs.privacy?.path ?? null };
}

export function legalPages(app: FastifyInstance, docs: LegalDocs) {
  const nav = [docs.imprint, docs.privacy].filter((x): x is LegalDoc => x !== null);
  for (const doc of nav) {
    app.get(doc.path, (_req, reply) => {
      reply.header('Cache-Control', 'public, max-age=300');
      reply.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
      return reply.type('text/html; charset=utf-8').send(`<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(doc.title)} – Berichtly Server</title>
<style>${LEGAL_CSS}</style>
</head>
<body>
<header><nav aria-label="Rechtliches">${nav.map((d) => `<a href="${d.path}"${d === doc ? ' aria-current="page"' : ''}>${esc(d.title)}</a>`).join('')}</nav></header>
<main>
<h1>${esc(doc.title)}</h1>
${doc.html}
</main>
</body>
</html>`);
    });
  }
}

// Systemschrift (keine externen Schriftarten); Kontraste ≥ 4,5 : 1 in Hell und Dunkel.
const LEGAL_CSS = `:root{--bg:#f6f7f9;--text:#151821;--muted:#5a6273;--link:#4a52d6}
@media (prefers-color-scheme: dark){:root{--bg:#0f1115;--text:#e7e9ee;--muted:#9aa3b2;--link:#8b93ff}}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
header,main{max-width:760px;margin:0 auto;padding:16px}nav{display:flex;gap:16px;flex-wrap:wrap}
a{color:var(--link)}a[aria-current]{color:var(--text);font-weight:600}a:focus-visible{outline:2px solid var(--link);outline-offset:2px}
h1{font-size:26px}h2{font-size:18px;margin-top:28px}`;
