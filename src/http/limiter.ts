// Rate Limiting (Token Bucket pro Schlüssel, im Prozess) und einfache Metriken.
// Ergänzt die Grundbegrenzung in Nginx: Nginx schützt vor Massenanfragen, der Server begrenzt
// zusätzlich Anmeldung, Registrierung und Token-Erneuerung pro IP bzw. pro Konto.

import { createHash } from 'node:crypto';

interface Bucket {
  tokens: number;
  last: number;
}

export class Limiter {
  private readonly perMinute: number;
  private readonly buckets = new Map<string, Bucket>();
  private lastCleanup = Date.now();
  private readonly now: () => number;

  constructor(perMinute: number, now: () => number = Date.now) {
    this.perMinute = perMinute;
    this.now = now;
  }

  /** Verbraucht ein Token; bei Ablehnung die Wartezeit in Sekunden (für Retry-After). */
  allow(key: string): { ok: true } | { ok: false; retryAfter: number } {
    const now = this.now();
    if (now - this.lastCleanup > 60_000) {
      for (const [k, b] of this.buckets) if (now - b.last > 600_000) this.buckets.delete(k);
      this.lastCleanup = now;
    }
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: this.perMinute, last: now };
      this.buckets.set(key, b);
    }
    b.tokens = Math.min(this.perMinute, b.tokens + ((now - b.last) / 60_000) * this.perMinute);
    b.last = now;
    if (b.tokens >= 1) {
      b.tokens--;
      return { ok: true };
    }
    return { ok: false, retryAfter: Math.ceil(((1 - b.tokens) / this.perMinute) * 60) };
  }
}

/** Schlüssel für das Rate Limiting, ohne den Klartext (z. B. E-Mail) im Speicher zu halten. */
export const hashKey = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 32);

export class Metrics {
  readonly started = new Date();
  total = 0;
  s2xx = 0;
  s3xx = 0;
  s4xx = 0;
  s5xx = 0;
  limited = 0;
  unhandled = 0;

  record(status: number) {
    this.total++;
    if (status >= 500) this.s5xx++;
    else if (status === 429) {
      this.s4xx++;
      this.limited++;
    } else if (status >= 400) this.s4xx++;
    else if (status >= 300) this.s3xx++;
    else this.s2xx++;
  }

  snapshot() {
    return {
      requestsTotal: this.total, responses2xx: this.s2xx, responses3xx: this.s3xx, responses4xx: this.s4xx,
      responses5xx: this.s5xx, rateLimited: this.limited, unhandledErrors: this.unhandled,
    };
  }
}
