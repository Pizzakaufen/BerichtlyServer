import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { PasswordHasher } from '../../src/security/password.ts';
import { hashRefreshToken, newRefreshToken, Tokens } from '../../src/security/tokens.ts';

test('Argon2id-Hash ist gesalzen und verifizierbar', async () => {
  const h = new PasswordHasher();
  const a = await h.hash('geheimes-Passwort-1');
  const b = await h.hash('geheimes-Passwort-1');
  assert.notEqual(a, b);
  assert.ok(a.startsWith('$argon2id$v=19$m=19456,t=2,p=1$'), a);
  assert.equal(await h.verify('geheimes-Passwort-1', a), true);
  assert.equal(await h.verify('geheimes-Passwort-2', a), false);
  assert.equal(await h.verify('x', 'kein-hash'), false);
  assert.equal(h.needsRehash(a), false);
  const stronger = new PasswordHasher({ memory: 64 * 1024, passes: 2, parallelism: 1 });
  assert.equal(stronger.needsRehash(a), true, 'schwächerer Hash nicht erkannt');
});

test('Access Tokens', () => {
  const secret = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz');
  const opts = { secret, issuer: 'iss', audience: 'aud', ttlSec: 900, now: () => new Date() };
  const tok = new Tokens(opts);
  const user = randomUUID();
  const sess = randomUUID();
  const { token } = tok.issueAccessToken(user, sess);
  assert.deepEqual(tok.parseAccessToken(token), { userId: user, sessionId: sess });
  assert.throws(() => new Tokens({ ...opts, audience: 'andere-app' }).parseAccessToken(token), 'falsche Zielgruppe akzeptiert');
  assert.throws(() => new Tokens({ ...opts, issuer: 'anderer' }).parseAccessToken(token), 'falscher Aussteller akzeptiert');
  const expired = new Tokens({ ...opts, now: () => new Date(Date.now() - 3600_000) }).issueAccessToken(user, sess).token;
  assert.throws(() => tok.parseAccessToken(expired), 'abgelaufenes Token akzeptiert');
  const [h, p, s] = token.split('.');
  assert.throws(() => tok.parseAccessToken(`${h}.${p}.${s.slice(0, -2)}AA`), 'manipulierte Signatur akzeptiert');
  assert.throws(() => tok.parseAccessToken(`${h}.${p}`));
});

test('Refresh Tokens', () => {
  const a = newRefreshToken();
  const b = newRefreshToken();
  assert.notEqual(a, b);
  assert.match(a, /^brt_[A-Za-z0-9_-]{43}$/);
  assert.equal(hashRefreshToken(a)?.length, 32);
  assert.equal(hashRefreshToken('brt_kurz'), null);
  assert.equal(hashRefreshToken('x'.repeat(47)), null);
});
