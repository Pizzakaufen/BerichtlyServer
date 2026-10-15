-- Berichtly Server 2.0 – Rollen, Admin-Dashboard, Audit-Protokoll und Backup-Protokoll.
--
-- Rein additiv: Bestehende Tabellen und Daten bleiben unverändert. Alle bestehenden Konten erhalten die
-- Rolle 'user'; Administratorrechte vergibt ausschließlich die CLI (berichtly-server admin grant <E-Mail>).

ALTER TABLE users
    ADD COLUMN role VARCHAR(16) NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin'));

-- Sitzungen des Admin-Dashboards (getrennt von den App-Sitzungen). Gespeichert wird nur der SHA-256-Hash
-- des Cookie-Werts – das Cookie selbst ist in der Datenbank nicht rekonstruierbar.
CREATE TABLE admin_sessions (
    id           UUID PRIMARY KEY,
    user_id      UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    token_hash   BYTEA       NOT NULL,
    csrf_token   TEXT        NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at   TIMESTAMPTZ NOT NULL,
    revoked_at   TIMESTAMPTZ
);
CREATE UNIQUE INDEX admin_sessions_token_uq ON admin_sessions (token_hash);
CREATE INDEX admin_sessions_expires_idx ON admin_sessions (expires_at);

-- Nachvollziehbare Verwaltungsaktionen: wer, was, an wem, wann – ohne Inhalte, Passwörter oder Tokens.
CREATE TABLE admin_audit_log (
    id             BIGSERIAL PRIMARY KEY,
    admin_user_id  UUID        REFERENCES users (id) ON DELETE SET NULL,
    action         VARCHAR(48) NOT NULL,
    target_user_id UUID        REFERENCES users (id) ON DELETE SET NULL,
    target_ref     VARCHAR(64),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX admin_audit_log_created_idx ON admin_audit_log (created_at DESC);

-- Protokoll der Datenbank-Backups (vom Backup-Skript per CLI eingetragen). verified = die Datei wurde mit
-- pg_restore --list vollständig gelesen; das prüft Lesbarkeit und Struktur, nicht eine echte Wiederherstellung.
CREATE TABLE backup_runs (
    id           BIGSERIAL PRIMARY KEY,
    started_at   TIMESTAMPTZ NOT NULL,
    finished_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    file_name    VARCHAR(255) NOT NULL,
    size_bytes   BIGINT,
    sha256       VARCHAR(64),
    verified     BOOLEAN     NOT NULL DEFAULT false,
    verification VARCHAR(255),
    result       VARCHAR(16) NOT NULL CHECK (result IN ('SUCCESS', 'FAILED')),
    error        VARCHAR(255)
);
CREATE INDEX backup_runs_finished_idx ON backup_runs (finished_at DESC);
