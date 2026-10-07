// Nachbildung eines Android-Geräts mit lokaler Datenbank (nur so weit, wie für die Tests nötig).

import { DEFAULT_PASSWORD, type Env, type Res, type Session, uuid } from './helpers.ts';

interface LocalReport {
  version: number;
  text: string;
  deleted: boolean;
}

export class Device {
  readonly e: Env;
  readonly s: Session;
  readonly id: string;
  cursor = '0';
  local = new Map<string, LocalReport>();

  constructor(e: Env, s: Session, id: string) {
    this.e = e;
    this.s = s;
    this.id = id;
  }

  static async create(e: Env, email: string, register: boolean) {
    const id = uuid();
    const device = { id, name: `Gerät ${id.slice(0, 4)}` };
    const s = register
      ? await e.register(email, { device })
      : (await e.post('/api/v1/auth/login', '', { email, password: DEFAULT_PASSWORD, device })).expect(200).session();
    return new Device(e, s, id);
  }

  /** Vollständiger Synchronisationsvorgang (mit Pagination) inklusive Abschlussmeldung. */
  async sync(...changes: Record<string, unknown>[]): Promise<Res> {
    const first = (await this.e.post('/api/v1/sync', this.s.access, { cursor: this.cursor, limit: 50, changes })).expect(200);
    this.apply(first.data.pull);
    let more = first.data.pull.hasMore === true;
    while (more) {
      const page = (await this.e.get(`/api/v1/sync/changes?limit=50&cursor=${this.cursor}`, this.s.access)).expect(200);
      this.apply(page.data);
      more = page.data.hasMore === true;
    }
    (await this.e.post('/api/v1/sync/complete', this.s.access, { result: 'SUCCESS', cursor: this.cursor })).expect(200);
    return first;
  }

  apply(pull: { changes: { type: string; id: string; version: number; deleted: boolean; data: { text: string } | null }[]; nextCursor: string }) {
    for (const c of pull.changes) {
      if (c.type !== 'DAILY_REPORT') continue;
      this.local.set(c.id, { version: c.version, deleted: c.deleted, text: c.deleted ? '' : c.data!.text });
    }
    this.cursor = pull.nextCursor;
  }

  active(): Map<string, string> {
    return new Map([...this.local].filter(([, r]) => !r.deleted).map(([id, r]) => [id, r.text]));
  }
}

export function op(opId: string, id: string, base: number | null, kind: 'UPSERT' | 'DELETE', text: string): Record<string, unknown> {
  const c: Record<string, unknown> = {
    operationId: opId, type: 'DAILY_REPORT', operation: kind, id, baseVersion: base, clientUpdatedAt: '2026-10-05T07:00:00.000Z',
  };
  if (kind === 'UPSERT') c.data = { date: '2026-10-05', text };
  return c;
}

export const serverCount = async (e: Env, token: string): Promise<number> =>
  (await e.get('/api/v1/daily-reports?limit=1', token)).body.meta.total;
