// Server 2.2: Weboberfläche unter /app – nur eigene Dateien, strenge CSP, keine Drittanbieter, Kontraste.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../src/config/config.ts';
import { loadWebFiles, WEB_CSP } from '../../src/http/webapp.ts';

const SECRET = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyzABCDEF').toString('base64');
const env = (kv: Record<string, string | undefined> = {}) => ({ APP_ENV: 'test', DB_USER: 'berichtly', DB_PASSWORD: 'geheim', JWT_SECRET: SECRET, ...kv });
const WEB = fileURLToPath(new URL('../../web/', import.meta.url));

test('Weboberfläche ist standardmäßig aus', () => {
  assert.equal(loadConfig(env()).webApp.enabled, false);
  assert.equal(loadConfig(env({ WEB_APP_ENABLED: 'true' })).webApp.enabled, true);
});

test('nur Dateien aus web/ mit erlaubten Typen, inklusive Lizenzen der übernommenen Bibliotheken', () => {
  const files = loadWebFiles(WEB);
  for (const p of ['/app/index.html', '/app/app.js', '/app/app.css', '/app/fx.js', '/app/vendor/thinking-orbs/LICENSE', '/app/vendor/border-beam/LICENSE']) {
    assert.ok(files.has(p), `${p} fehlt`);
  }
  for (const [p, f] of files) assert.match(f.type, /^text\/(html|css|javascript|plain)/, p);
});

test('CSP erlaubt nur eigene Skripte, Stile und Verbindungen', () => {
  assert.match(WEB_CSP, /script-src 'self'/);
  assert.match(WEB_CSP, /style-src 'self'/);
  assert.match(WEB_CSP, /connect-src 'self'/);
  assert.doesNotMatch(WEB_CSP, /unsafe-inline|unsafe-eval|\*/);
});

test('keine externen Ressourcen und keine innerHTML-Zuweisungen', () => {
  const walk = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
  for (const file of walk(WEB).filter((f) => /\.(html|css|js)$/.test(f))) {
    const src = readFileSync(file, 'utf8');
    assert.doesNotMatch(src, /https?:\/\/(?!www\.w3\.org)/, `${file} lädt eine externe Ressource`);
    if (!file.includes('vendor')) assert.doesNotMatch(src, /\.innerHTML\s*=/, `${file} setzt innerHTML`);
  }
});

function luminance(hex: string): number {
  const h = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = Number.parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const ratio = (a: string, b: string) => {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
};
const vars = (block: string) => Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1], m[2]]));

test('Farben der Weboberfläche erfüllen WCAG 2.2 AA in Hell und Dunkel', () => {
  const css = readFileSync(join(WEB, 'app.css'), 'utf8');
  const light = vars(css.match(/^:root \{[\s\S]*?\n\}/m)![0]);
  const dark = { ...light, ...vars(css.match(/:root\[data-theme="dark"\] \{[\s\S]*?\n\}/)![0]) };
  for (const [mode, c] of Object.entries({ light, dark })) {
    for (const bg of ['bg', 'surface', 'surface-2', 'surface-3']) {
      for (const fg of ['ink', 'ink-2', 'accent']) assert.ok(ratio(c[fg], c[bg]) >= 4.5, `${mode}: --${fg} auf --${bg}`);
      assert.ok(ratio(c.outline, c[bg]) >= 3, `${mode}: --outline auf --${bg}`);
    }
    for (const [fg, bg] of [['on-accent', 'accent'], ['on-accent-soft', 'accent-soft'], ['ok', 'ok-soft'], ['warn', 'warn-soft'], ['err', 'err-soft'], ['run', 'run-soft']]) {
      assert.ok(ratio(c[fg], c[bg]) >= 4.5, `${mode}: --${fg} auf --${bg}`);
    }
  }
});
