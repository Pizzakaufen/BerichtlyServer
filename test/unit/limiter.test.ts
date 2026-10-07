import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hashKey, Limiter } from '../../src/http/limiter.ts';

test('Token Bucket pro Schlüssel', () => {
  let now = 1_000_000;
  const l = new Limiter(3, () => now);
  for (let i = 0; i < 3; i++) assert.equal(l.allow('1.2.3.4').ok, true, 'Anfrage innerhalb des Limits abgelehnt');
  const denied = l.allow('1.2.3.4');
  assert.equal(denied.ok, false);
  assert.ok(!denied.ok && denied.retryAfter >= 1);
  assert.equal(l.allow('5.6.7.8').ok, true, 'andere IP fälschlich begrenzt');
  now += 20_000; // nach 20 s ist ein Token nachgefüllt (3 pro Minute)
  assert.equal(l.allow('1.2.3.4').ok, true);
  assert.equal(l.allow('1.2.3.4').ok, false);
});

test('Rate-Limit-Schlüssel enthält keinen Klartext', () => {
  const k = hashKey('anna@example.org');
  assert.match(k, /^[0-9a-f]{32}$/);
  assert.ok(!k.includes('anna'));
  assert.equal(k, hashKey('anna@example.org'));
});
