-- Berichtly Server 1.0 Alpha – initiales Schema.
-- Alle Zeitpunkte werden als TIMESTAMPTZ (UTC) gespeichert. Reine Kalenderdaten (Arbeitstag,
-- Wochenstart) sind DATE-Werte und werden in der Zeitzone des Benutzers interpretiert.
-- Primärschlüssel sind UUIDs, damit Datensätze unabhängig von Autoincrement-Werten zwischen
-- Android-Geräten und Server abgeglichen werden können.

-- Globale, monoton steigende Änderungsnummer für die Synchronisierung ("Cursor").
CREATE SEQUENCE sync_change_seq AS BIGINT START WITH 1 INCREMENT BY 1;

-- Setzt bei jedem INSERT/UPDATE updated_at und eine neue Änderungsnummer.
-- Die Versionsnummer (optimistische Sperre) setzt bewusst die Anwendung.
CREATE FUNCTION berichtly_touch_syncable() RETURNS trigger AS $$
BEGIN
    NEW.updated_at := now();
    NEW.change_seq := nextval('sync_change_seq');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION berichtly_touch_updated_at() RETURNS trigger AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- Benutzerkonten
-- ---------------------------------------------------------------------------
CREATE TABLE users (
    id                    UUID PRIMARY KEY,
    email                 VARCHAR(254) NOT NULL,
    password_hash         TEXT         NOT NULL,
    status                VARCHAR(16)  NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISABLED')),
    timezone              VARCHAR(64)  NOT NULL,
    failed_login_attempts INTEGER      NOT NULL DEFAULT 0,
    locked_until          TIMESTAMPTZ,
    last_login_at         TIMESTAMPTZ,
    password_changed_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
    created_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT users_email_normalized CHECK (email = lower(email))
);
CREATE UNIQUE INDEX users_email_uq ON users (email);
CREATE TRIGGER users_touch BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION berichtly_touch_updated_at();

-- ---------------------------------------------------------------------------
-- Profil (genau eines pro Benutzer, Felder entsprechen der Android-App)
-- ---------------------------------------------------------------------------
CREATE TABLE user_profiles (
    user_id        UUID PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    name           VARCHAR(120) NOT NULL DEFAULT '',
    profession     VARCHAR(120) NOT NULL DEFAULT '',
    company        VARCHAR(160) NOT NULL DEFAULT '',
    department     VARCHAR(120) NOT NULL DEFAULT '',
    trainer_name   VARCHAR(120) NOT NULL DEFAULT '',
    training_start DATE,
    training_end   DATE,
    writing_style  VARCHAR(16)  NOT NULL DEFAULT 'NEUTRAL'
        CHECK (writing_style IN ('NEUTRAL', 'FORMAL', 'SIMPLE', 'DETAILED')),
    version        INTEGER      NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
    change_seq     BIGINT       NOT NULL,
    CONSTRAINT user_profiles_training_range
        CHECK (training_start IS NULL OR training_end IS NULL OR training_end >= training_start)
);
CREATE INDEX user_profiles_change_seq_idx ON user_profiles (user_id, change_seq);
CREATE TRIGGER user_profiles_touch BEFORE INSERT OR UPDATE ON user_profiles
    FOR EACH ROW EXECUTE FUNCTION berichtly_touch_syncable();

-- ---------------------------------------------------------------------------
-- Geräte und Sitzungen
-- ---------------------------------------------------------------------------
-- device_id ist die stabile, vom Client erzeugte Geräte-ID (UUID). Sie ist nur pro Benutzer
-- eindeutig, damit ein Client niemals das Gerät eines anderen Kontos "übernehmen" kann.
CREATE TABLE devices (
    id                UUID PRIMARY KEY,
    user_id           UUID         NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    device_id         UUID         NOT NULL,
    name              VARCHAR(100) NOT NULL DEFAULT '',
    platform          VARCHAR(32)  NOT NULL DEFAULT 'ANDROID',
    app_version       VARCHAR(32)  NOT NULL DEFAULT '',
    created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
    last_seen_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    last_pull_at      TIMESTAMPTZ,
    last_pull_cursor  BIGINT,
    last_push_at      TIMESTAMPTZ,
    CONSTRAINT devices_user_device_uq UNIQUE (user_id, device_id)
);
CREATE TRIGGER devices_touch BEFORE UPDATE ON devices
    FOR EACH ROW EXECUTE FUNCTION berichtly_touch_updated_at();

CREATE TABLE sessions (
    id            UUID PRIMARY KEY,
    user_id       UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    device_ref    UUID        REFERENCES devices (id) ON DELETE SET NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at    TIMESTAMPTZ NOT NULL,
    revoked_at    TIMESTAMPTZ,
    revoke_reason VARCHAR(32)
);
CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_device_idx ON sessions (device_ref);

-- Refresh Tokens werden nur als SHA-256-Hash gespeichert. Jedes Token ist genau einmal
-- verwendbar (Rotation); eine erneute Verwendung widerruft die gesamte Sitzung.
CREATE TABLE refresh_tokens (
    id          UUID PRIMARY KEY,
    session_id  UUID        NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
    token_hash  BYTEA       NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ NOT NULL,
    used_at     TIMESTAMPTZ
);
CREATE UNIQUE INDEX refresh_tokens_hash_uq ON refresh_tokens (token_hash);
CREATE INDEX refresh_tokens_session_idx ON refresh_tokens (session_id);

-- ---------------------------------------------------------------------------
-- Tagesberichte (entspricht den Tätigkeiten eines Tages in der Android-App)
-- ---------------------------------------------------------------------------
CREATE TABLE daily_reports (
    id               UUID PRIMARY KEY,
    user_id          UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    report_date      DATE        NOT NULL,
    text             TEXT        NOT NULL DEFAULT '',
    note             TEXT        NOT NULL DEFAULT '',
    order_index      INTEGER     NOT NULL DEFAULT 0 CHECK (order_index >= 0),
    status           VARCHAR(16) NOT NULL DEFAULT 'DRAFT'
        CHECK (status IN ('DRAFT', 'GENERATED', 'EDITED', 'FINALIZED')),
    version          INTEGER     NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at       TIMESTAMPTZ,
    change_seq       BIGINT      NOT NULL,
    last_device_ref  UUID        REFERENCES devices (id) ON DELETE SET NULL
);
CREATE INDEX daily_reports_user_date_idx ON daily_reports (user_id, report_date) WHERE deleted_at IS NULL;
CREATE INDEX daily_reports_user_change_idx ON daily_reports (user_id, change_seq);
CREATE INDEX daily_reports_user_updated_idx ON daily_reports (user_id, updated_at);
CREATE TRIGGER daily_reports_touch BEFORE INSERT OR UPDATE ON daily_reports
    FOR EACH ROW EXECUTE FUNCTION berichtly_touch_syncable();

-- ---------------------------------------------------------------------------
-- Wochenberichte (ein aktiver Bericht pro Benutzer und ISO-Woche, Montag bis Sonntag)
-- ---------------------------------------------------------------------------
CREATE TABLE weekly_reports (
    id               UUID PRIMARY KEY,
    user_id          UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    week_start       DATE        NOT NULL CHECK (extract(isodow FROM week_start) = 1),
    week_end         DATE        NOT NULL,
    iso_year         INTEGER     NOT NULL,
    iso_week         INTEGER     NOT NULL CHECK (iso_week BETWEEN 1 AND 53),
    content          TEXT        NOT NULL DEFAULT '',
    status           VARCHAR(16) NOT NULL DEFAULT 'DRAFT'
        CHECK (status IN ('DRAFT', 'GENERATED', 'EDITED', 'FINALIZED')),
    generated_at     TIMESTAMPTZ,
    version          INTEGER     NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at       TIMESTAMPTZ,
    change_seq       BIGINT      NOT NULL,
    last_device_ref  UUID        REFERENCES devices (id) ON DELETE SET NULL,
    CONSTRAINT weekly_reports_week_range CHECK (week_end = week_start + 6)
);
CREATE UNIQUE INDEX weekly_reports_user_week_uq ON weekly_reports (user_id, week_start) WHERE deleted_at IS NULL;
CREATE INDEX weekly_reports_user_change_idx ON weekly_reports (user_id, change_seq);
CREATE INDEX weekly_reports_user_updated_idx ON weekly_reports (user_id, updated_at);
CREATE TRIGGER weekly_reports_touch BEFORE INSERT OR UPDATE ON weekly_reports
    FOR EACH ROW EXECUTE FUNCTION berichtly_touch_syncable();
