// Server 2.1: Kontraste des Dashboards, sichere Rechtsseiten, keine Drittanbieter-Ressourcen, datensparsame Vorgaben.
//
// HINWEIS: geschrieben, aber in der Entwicklungsumgebung nicht ausgeführt (kein Node.js verfügbar).

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { loadConfig } from '../../src/config/config.ts';
import { ADMIN_CSS } from '../../src/http/admin.ts';
import { legalLinks, renderLegalText } from '../../src/http/legal.ts';

const SECRET = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyzABCDEF').toString('base64');
const env = (kv: Record<string, string | undefined> = {}) => ({ APP_ENV: 'test', DB_USER: 'berichtly', DB_PASSWORD: 'geheim', JWT_SECRET: SECRET, ...kv });

function luminance(hex: string): number {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = Number.parseInt(full.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const ratio = (a: string, b: string) => {
  const [x, y] = [luminance(a) + 0.05, luminance(b) + 0.05];
  return Math.max(x, y) / Math.min(x, y);
};

/** Liest die Farbvariablen eines :root-Blocks aus dem CSS. */
function vars(block: string): Record<string, string> {
  return Object.fromEntries([...block.matchAll(/--([a-z-]+):(#[0-9a-fA-F]{3,6})/g)].map((m) => [m[1], m[2]]));
}

test('Dashboard-Farben erfüllen WCAG 2.2 AA in Dunkel und Hell', () => {
  const dark = vars(ADMIN_CSS.match(/^:root\{[^}]*\}/m)![0]);
  const light = { ...dark, ...vars(ADMIN_CSS.match(/prefers-color-scheme: light\)\{:root\{[^}]*\}/)![0]) };
  for (const [mode, c] of Object.entries({ dark, light })) {
    for (const bg of ['bg', 'card']) {
      for (const fg of ['text', 'muted', 'primary', 'ok', 'warn', 'bad']) {
        assert.ok(ratio(c[fg], c[bg]) >= 4.5, `${mode}: --${fg} auf --${bg} = ${ratio(c[fg], c[bg]).toFixed(2)}`);
      }
      assert.ok(ratio(c.field, c[bg]) >= 3, `${mode}: Eingaberahmen auf --${bg}`);
    }
    assert.ok(ratio(c['on-primary'], c.primary) >= 4.5, `${mode}: Schaltflächentext`);
  }
});

test('Dashboard hat sichtbaren Fokus, Sprunglink, große Ziele und reduzierte Bewegung', () => {
  assert.match(ADMIN_CSS, /:focus-visible\{outline:2px solid/);
  assert.match(ADMIN_CSS, /\.skip:focus/);
  assert.match(ADMIN_CSS, /prefers-reduced-motion: reduce/);
  assert.match(ADMIN_CSS, /min-height:44px/);
});

test('Rechtsseiten: Text des Betreibers wird vollständig maskiert', () => {
  const html = renderLegalText('# Anbieter\n\nMax <b>Muster</b>\nStraße 1\n\n<script>alert(1)</script>');
  assert.equal(html, '<h2>Anbieter</h2>\n<p>Max &lt;b&gt;Muster&lt;/b&gt;<br>Straße 1</p>\n<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
});

test('Rechtsseiten: ohne hinterlegte Datei gibt es keine Seite und keine erfundenen Angaben', () => {
  const c = loadConfig(env());
  assert.deepEqual(c.legal, { imprintFile: undefined, privacyFile: undefined });
  assert.deepEqual(legalLinks({ imprint: null, privacy: null }), { imprintUrl: null, privacyUrl: null });
  assert.throws(() => loadConfig(env({ LEGAL_PRIVACY_FILE: 'relativ.txt' })), /absoluter Pfad/);
});

test('Verwaltungsprotokoll hat eine begrenzte Aufbewahrung', () => {
  assert.equal(loadConfig(env()).admin.auditRetentionSec, 365 * 86_400);
  assert.throws(() => loadConfig(env({ ADMIN_AUDIT_RETENTION_DAYS: '1' })));
});

test('Server lädt keine Ressourcen von Drittanbietern (Schriften, Skripte, Analyse)', () => {
  const dir = new URL('../../src/http/', import.meta.url);
  const forbidden = /fonts\.googleapis|fonts\.gstatic|unpkg\.com|jsdelivr|cdnjs|google-analytics|googletagmanager|matomo|plausible|<script src=/;
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
    const src = readFileSync(new URL(file, dir), 'utf8');
    assert.ok(!forbidden.test(src), `${file} verweist auf eine externe Ressource`);
  }
});

test('keine Tracking- oder Analyse-Abhängigkeiten', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as Record<string, Record<string, string> | undefined>;
  const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  const tracking = deps.filter((d) => /analytics|sentry|segment|mixpanel|posthog|datadog|newrelic|amplitude|bugsnag/i.test(d));
  assert.deepEqual(tracking, []);
});
