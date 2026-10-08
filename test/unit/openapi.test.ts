// Jede registrierte Route muss in der OpenAPI-Spezifikation dokumentiert sein, und alle Versionsangaben
// (package.json, VERSION, OpenAPI) müssen übereinstimmen.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parse } from 'yaml';
import { App, VERSION } from '../../src/app.ts';
import { loadConfig } from '../../src/config/config.ts';
import { silentLogger } from '../../src/util/logger.ts';

const spec = parse(readFileSync(new URL('../../api/openapi.yaml', import.meta.url), 'utf8')) as {
  info: { version: string };
  paths: Record<string, Record<string, unknown>>;
};

test('Versionsangaben stimmen überein', () => {
  assert.equal(VERSION, '1.2.1');
  assert.equal(readFileSync(new URL('../../VERSION', import.meta.url), 'utf8').trim(), VERSION);
  assert.equal(spec.info.version, VERSION);
});

test('OpenAPI dokumentiert alle Routen', async () => {
  // Der Server wird ohne Datenbankverbindung aufgebaut (der Pool verbindet sich erst bei der ersten Abfrage).
  const cfg = loadConfig({
    APP_ENV: 'test', DB_USER: 'x', DB_PASSWORD: 'x', DB_PORT: '1', API_DOCS_ENABLED: 'false',
    JWT_SECRET: Buffer.from('0123456789abcdefghijklmnopqrstuvwxyzABCDEF').toString('base64'),
  });
  const app = new App(cfg, silentLogger());
  const server = await app.buildServer();
  try {
    const routes = server.routes.filter((r) => r.url.startsWith('/api/v1/') && r.method !== 'HEAD');
    assert.equal(routes.length, 39, "v1 hat 39 Endpunkte wie in 1.1");
    for (const r of routes) {
      const path = r.url.replace(/:([A-Za-z]+)/g, '{$1}');
      assert.ok(spec.paths[path], `Pfad fehlt in openapi.yaml: ${path}`);
      assert.ok(spec.paths[path][r.method.toLowerCase()], `Methode ${r.method} fehlt für ${path}`);
    }
    // Umgekehrt: keine dokumentierten Endpunkte, die es nicht gibt.
    const known = new Set(routes.map((r) => `${r.method.toLowerCase()} ${r.url.replace(/:([A-Za-z]+)/g, '{$1}')}`));
    for (const [path, ops] of Object.entries(spec.paths)) {
      if (!path.startsWith('/api/v1/')) continue;
      for (const m of Object.keys(ops).filter((k) => ['get', 'post', 'put', 'patch', 'delete'].includes(k))) {
        assert.ok(known.has(`${m} ${path}`), `dokumentiert, aber nicht implementiert: ${m.toUpperCase()} ${path}`);
      }
    }
  } finally {
    await server.close(1000);
    await app.close();
  }
});
