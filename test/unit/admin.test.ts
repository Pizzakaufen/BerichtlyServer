// Server 2.0: sichere Voreinstellungen des Admin-Dashboards und HTML-Maskierung.
//
// HINWEIS: geschrieben, aber in der Entwicklungsumgebung nicht ausgeführt (kein Node.js verfügbar).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../../src/config/config.ts';
import { esc } from '../../src/http/admin.ts';
import { hashToken, sameToken } from '../../src/services/admin.ts';

const SECRET = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyzABCDEF').toString('base64');
const env = (kv: Record<string, string | undefined> = {}) => ({ APP_ENV: 'test', DB_USER: 'berichtly', DB_PASSWORD: 'geheim', JWT_SECRET: SECRET, ...kv });

test('Admin-Dashboard ist standardmäßig aus', () => {
  const c = loadConfig(env());
  assert.equal(c.admin.enabled, false);
  assert.equal(c.admin.sessionIdleSec, 30 * 60);
  assert.equal(c.admin.sessionMaxSec, 8 * 3600);
});

test('in Produktion ist das Cookie immer Secure – auch wenn anders eingestellt', () => {
  const c = loadConfig(env({ APP_ENV: 'production', ADMIN_DASHBOARD_ENABLED: 'true', ADMIN_COOKIE_SECURE: 'false' }));
  assert.equal(c.admin.cookieSecure, true);
  assert.equal(loadConfig(env({ ADMIN_COOKIE_SECURE: 'false' })).admin.cookieSecure, false); // nur außerhalb der Produktion
});

test('ungültige Sitzungsdauern werden abgelehnt', () => {
  assert.throws(() => loadConfig(env({ ADMIN_SESSION_IDLE_MINUTES: '1' })));
  assert.throws(() => loadConfig(env({ ADMIN_SESSION_MAX_HOURS: '100' })));
});

test('HTML wird vollständig maskiert', () => {
  assert.equal(esc('<a href="x" onclick=\'y\'>&</a>'), '&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
  assert.equal(esc(null), '');
});

test('Tokens werden nur als Hash gespeichert und zeitkonstant verglichen', () => {
  assert.equal(hashToken('abc').length, 32);
  assert.notDeepEqual(hashToken('abc'), hashToken('abd'));
  assert.equal(sameToken('a'.repeat(43), 'a'.repeat(43)), true);
  assert.equal(sameToken('a'.repeat(43), 'b'.repeat(43)), false);
  assert.equal(sameToken('a', 'aa'), false);
});
