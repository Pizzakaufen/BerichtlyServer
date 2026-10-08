import assert from 'node:assert/strict';
import { createHash, X509Certificate } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { connectUri, tlsInfo } from '../../src/security/tls.ts';

const SCRIPT = fileURLToPath(new URL('../../deploy/tls-selfsigned.sh', import.meta.url));
const run = (ip: string, dir: string) =>
  execFileSync('sh', [SCRIPT, ip, dir.replaceAll('\\', '/')], { stdio: 'pipe', env: { ...process.env, MSYS2_ARG_CONV_EXCL: '*' } });

let shAvailable = true;
try {
  execFileSync('sh', ['-c', 'command -v openssl'], { stdio: 'ignore' });
} catch {
  shAvailable = false;
}

test('eigenes Zertifikat für die IP: Pin bleibt bei Verlängerung und neuer IP gleich', { skip: shAvailable ? false : 'sh/openssl fehlt' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'berichtly-tls-'));
  try {
    run('203.0.113.10', dir);
    const first = readFileSync(join(dir, 'server.crt'));
    const info = tlsInfo(first);
    assert.match(info.pin, /^sha256\/[A-Za-z0-9+/]{43}=$/);
    assert.equal(info.subjectAltName, 'IP Address:203.0.113.10');
    assert.ok(info.validTo.getTime() - Date.now() > 9 * 365 * 86400_000, 'Zertifikat sollte rund 10 Jahre gelten');
    // Pin = SHA-256 über den öffentlichen Schlüssel (SubjectPublicKeyInfo), wie OkHttp ihn berechnet.
    const spki = new X509Certificate(first).publicKey.export({ type: 'spki', format: 'der' });
    assert.equal(info.pin, 'sha256/' + createHash('sha256').update(spki).digest('base64'));

    run('203.0.113.10', dir); // erneuter Aufruf: nichts ändert sich
    assert.deepEqual(readFileSync(join(dir, 'server.crt')), first);

    run('198.51.100.7', dir); // neue IP: neues Zertifikat, gleicher Schlüssel, gleicher Pin
    const moved = tlsInfo(readFileSync(join(dir, 'server.crt')));
    assert.equal(moved.subjectAltName, 'IP Address:198.51.100.7');
    assert.equal(moved.pin, info.pin);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Verbindungsdaten für die App (QR-Code)', () => {
  const uri = connectUri('203.0.113.10', 'sha256/abc+/=');
  assert.equal(uri, 'berichtly://server?url=https%3A%2F%2F203.0.113.10&pin=sha256%2Fabc%2B%2F%3D');
  const parsed = new URL(uri);
  assert.equal(parsed.searchParams.get('url'), 'https://203.0.113.10');
  assert.equal(parsed.searchParams.get('pin'), 'sha256/abc+/=');
});
