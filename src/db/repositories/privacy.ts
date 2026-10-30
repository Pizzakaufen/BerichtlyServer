// Datenauskunft (Export) und Kontolöschung (seit 2.1).
// Der Export enthält alle Daten, die der Server zu einem Konto speichert – außer Passwort-Hash und Token-Hashes.

import type { Queryable } from '../pool.ts';

export async function exportUserData(q: Queryable, userId: string) {
  const one = async (sql: string) => (await q.query(sql, [userId])).rows[0] ?? null;
  const all = async (sql: string) => (await q.query(sql, [userId])).rows;
  return {
    account: await one(`SELECT email, status, role, timezone, last_login_at, password_changed_at, created_at, updated_at
      FROM users WHERE id = $1`),
    profile: await one(`SELECT name, profession, company, department, trainer_name, training_start, training_end, writing_style,
      version, created_at, updated_at FROM user_profiles WHERE user_id = $1`),
    dailyReports: await all(`SELECT id, report_date, text, note, order_index, status, version, created_at, updated_at, deleted_at
      FROM daily_reports WHERE user_id = $1 ORDER BY report_date, order_index`),
    weeklyReports: await all(`SELECT id, week_start, week_end, content, status, generated_at, version, created_at, updated_at, deleted_at
      FROM weekly_reports WHERE user_id = $1 ORDER BY week_start`),
    devices: await all(`SELECT device_id, name, platform, os_version, app_version, created_at, last_seen_at, revoked_at, sync_status
      FROM devices WHERE user_id = $1 ORDER BY created_at`),
    sessions: await all(`SELECT id, created_at, last_used_at, expires_at, revoked_at, revoke_reason
      FROM sessions WHERE user_id = $1 ORDER BY created_at`),
    securityEvents: await all(`SELECT event_type, created_at FROM security_events WHERE user_id = $1 ORDER BY created_at`),
  };
}

export async function userRole(q: Queryable, userId: string): Promise<string | null> {
  const { rows } = await q.query<{ role: string }>('SELECT role FROM users WHERE id = $1', [userId]);
  return rows[0]?.role ?? null;
}

/** Löscht das Konto; Profil, Berichte, Geräte, Sitzungen, Tokens und Sicherheitsereignisse folgen per ON DELETE CASCADE. */
export async function deleteUser(q: Queryable, userId: string): Promise<boolean> {
  const { rowCount } = await q.query('DELETE FROM users WHERE id = $1', [userId]);
  return (rowCount ?? 0) > 0;
}
