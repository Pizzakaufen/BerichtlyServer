import type { User } from '../../domain/models.ts';
import type { Queryable } from '../pool.ts';

const USER_COLUMNS = `id, email, password_hash, status, timezone, created_at,
  (locked_until IS NOT NULL AND locked_until > now()) AS locked`;

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  status: 'ACTIVE' | 'DISABLED';
  timezone: string;
  created_at: Date;
  locked: boolean;
}

const mapUser = (r: UserRow): User => ({
  id: r.id, email: r.email, passwordHash: r.password_hash, status: r.status, timezone: r.timezone,
  locked: r.locked, createdAt: r.created_at,
});

export async function insertUser(q: Queryable, id: string, email: string, passwordHash: string, timezone: string) {
  await q.query('INSERT INTO users (id, email, password_hash, timezone) VALUES ($1, $2, $3, $4)',
    [id, email, passwordHash, timezone]);
}

export async function findUserByEmail(q: Queryable, email: string): Promise<User | null> {
  const { rows } = await q.query<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE email = $1`, [email]);
  return rows[0] ? mapUser(rows[0]) : null;
}

export async function findUserById(q: Queryable, id: string): Promise<User | null> {
  const { rows } = await q.query<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [id]);
  return rows[0] ? mapUser(rows[0]) : null;
}

/** Zählt einen Fehlversuch; beim Erreichen von maxAttempts wird das Konto vorübergehend gesperrt. */
export async function recordFailedLogin(q: Queryable, id: string, maxAttempts: number, lockoutSec: number) {
  await q.query(`UPDATE users SET
      failed_login_attempts = CASE WHEN failed_login_attempts + 1 >= $1 THEN 0 ELSE failed_login_attempts + 1 END,
      locked_until = CASE WHEN failed_login_attempts + 1 >= $1
        THEN now() + make_interval(secs => $2) ELSE locked_until END
    WHERE id = $3`, [maxAttempts, lockoutSec, id]);
}

/** Setzt Fehlversuche zurück und speichert optional einen neuen Hash (stärkere Parameter). */
export async function recordSuccessfulLogin(q: Queryable, id: string, newHash: string | null) {
  await q.query(`UPDATE users SET failed_login_attempts = 0, locked_until = NULL, last_login_at = now(),
      password_hash = COALESCE($1, password_hash) WHERE id = $2`, [newHash, id]);
}

export async function updateUserTimezone(q: Queryable, id: string, tz: string) {
  await q.query('UPDATE users SET timezone = $1 WHERE id = $2', [tz, id]);
}

export async function updatePassword(q: Queryable, id: string, hash: string) {
  await q.query(`UPDATE users SET password_hash = $1, password_changed_at = now(),
      failed_login_attempts = 0, locked_until = NULL WHERE id = $2`, [hash, id]);
}
