// Argon2id (RFC 9106) über das in Node.js eingebaute crypto.argon2 – ohne native Zusatzpakete.
// PHC-Format: $argon2id$v=19$m=<KiB>,t=<Iterationen>,p=<Parallelität>$<salt>$<hash>
// Kompatibel mit den Hashes von Berichtly Server 1.0/1.1 (Bestandskonten melden sich unverändert an).

import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';

const SALT_BYTES = 16;
const HASH_BYTES = 32;

interface Params {
  memory: number; // KiB
  passes: number;
  parallelism: number;
}

interface Parsed extends Params {
  salt: Buffer;
  hash: Buffer;
}

const b64 = (b: Buffer) => b.toString('base64').replace(/=+$/, '');

function derive(password: string, salt: Buffer, p: Params, tagLength: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2('argon2id', { message: Buffer.from(password, 'utf8'), nonce: salt, parallelism: p.parallelism, tagLength,
      memory: p.memory, passes: p.passes }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

function parse(encoded: string): Parsed | null {
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[1] !== 'argon2id' || parts[2] !== 'v=19') return null;
  const values: Record<string, number> = {};
  for (const kv of parts[3].split(',')) {
    const [k, v] = kv.split('=');
    if (!/^\d+$/.test(v ?? '')) return null;
    values[k] = Number(v);
  }
  const { m, t, p } = values;
  if (!m || !t || !p || m < 8 || m > 4 * 1024 * 1024 || t > 64 || p > 255) return null;
  const salt = Buffer.from(parts[4], 'base64');
  const hash = Buffer.from(parts[5], 'base64');
  if (salt.length < 8 || hash.length < 16) return null;
  return { memory: m, passes: t, parallelism: p, salt, hash };
}

/**
 * Standardparameter nach OWASP-Empfehlung (m = 19 MiB, t = 2, p = 1). Gleichzeitige Berechnungen
 * sind begrenzt, damit Login-Spitzen auf kleinen Servern den Speicher nicht erschöpfen.
 */
export class PasswordHasher {
  readonly params: Params;
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  private readonly maxConcurrent: number;
  private dummy: Promise<string> | null = null;

  constructor(params: Params = { memory: 19 * 1024, passes: 2, parallelism: 1 }, maxConcurrent = 4) {
    this.params = params;
    this.maxConcurrent = maxConcurrent;
  }

  private async limited<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.maxConcurrent) await new Promise<void>((r) => this.waiting.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }

  async hash(password: string): Promise<string> {
    const salt = randomBytes(SALT_BYTES);
    const key = await this.limited(() => derive(password, salt, this.params, HASH_BYTES));
    const p = this.params;
    return `$argon2id$v=19$m=${p.memory},t=${p.passes},p=${p.parallelism}$${b64(salt)}$${b64(key)}`;
  }

  /** Vergleich in konstanter Zeit. */
  async verify(password: string, encoded: string): Promise<boolean> {
    const parsed = parse(encoded);
    if (!parsed) return false;
    const key = await this.limited(() => derive(password, parsed.salt, parsed, parsed.hash.length));
    return key.length === parsed.hash.length && timingSafeEqual(key, parsed.hash);
  }

  /** Rechnet gegen einen festen Dummy-Hash, damit unbekannte E-Mails genauso lange dauern (gegen Enumeration). */
  async verifyDummy(password: string): Promise<void> {
    this.dummy ??= this.hash('berichtly-timing-equalizer');
    await this.verify(password, await this.dummy);
  }

  /** true, wenn der Hash mit schwächeren Parametern erzeugt wurde. */
  needsRehash(encoded: string): boolean {
    const p = parse(encoded);
    return !p || p.memory < this.params.memory || p.passes < this.params.passes || p.parallelism < this.params.parallelism;
  }
}
