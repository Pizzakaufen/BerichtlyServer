-- Berichtly Server 1.1 – Geräteverwaltung, Sync-Status, Idempotenz, Sicherheitsereignisse.
--
-- Diese Migration ist rein additiv: Es werden nur Spalten, Tabellen und Indizes ergänzt.
-- Bestehende Benutzer, Profile, Sitzungen, Geräte und Berichte aus 1.0 Alpha bleiben unverändert.

-- ---------------------------------------------------------------------------
-- Geräte: Betriebssystem, Widerruf, Synchronisationsstatus
-- ---------------------------------------------------------------------------
ALTER TABLE devices
    ADD COLUMN os_version              VARCHAR(32) NOT NULL DEFAULT '',
    ADD COLUMN revoked_at              TIMESTAMPTZ,
    -- NEVER = noch nie erfolgreich/fehlgeschlagen abgeschlossen, SUCCESS, FAILED, CONFLICT
    ADD COLUMN sync_status             VARCHAR(16) NOT NULL DEFAULT 'NEVER'
        CHECK (sync_status IN ('NEVER', 'SUCCESS', 'FAILED', 'CONFLICT')),
    ADD COLUMN last_sync_started_at    TIMESTAMPTZ,
    ADD COLUMN last_successful_sync_at TIMESTAMPTZ,
    ADD COLUMN last_successful_cursor  BIGINT,
    ADD COLUMN last_failed_sync_at     TIMESTAMPTZ,
    ADD COLUMN last_sync_error_code    VARCHAR(64),
    ADD COLUMN unresolved_conflicts    INTEGER NOT NULL DEFAULT 0 CHECK (unresolved_conflicts >= 0);

CREATE INDEX devices_user_seen_idx ON devices (user_id, last_seen_at DESC);

-- ---------------------------------------------------------------------------
-- Berichte: Herkunft und Client-Zeit (getrennt von der maßgeblichen Serverzeit)
-- ---------------------------------------------------------------------------
-- client_updated_at: vom Gerät gemeldeter Änderungszeitpunkt – nur informativ, nie für Entscheidungen.
-- client_local_id:   lokale ID des Datensatzes auf dem Gerät (z. B. Room-ID), zur Nachvollziehbarkeit.
-- created_by_device_ref / last_device_ref: Gerät der Erstellung bzw. letzten Änderung.
-- last_operation_id: Synchronisationsoperation, die die letzte Änderung erzeugt hat.
ALTER TABLE daily_reports
    ADD COLUMN client_updated_at     TIMESTAMPTZ,
    ADD COLUMN client_local_id       VARCHAR(64),
    ADD COLUMN created_by_device_ref UUID REFERENCES devices (id) ON DELETE SET NULL,
    ADD COLUMN last_operation_id     UUID;

ALTER TABLE weekly_reports
    ADD COLUMN client_updated_at     TIMESTAMPTZ,
    ADD COLUMN client_local_id       VARCHAR(64),
    ADD COLUMN created_by_device_ref UUID REFERENCES devices (id) ON DELETE SET NULL,
    ADD COLUMN last_operation_id     UUID;

-- Für die Bereinigung alter Tombstones.
CREATE INDEX daily_reports_tombstone_idx ON daily_reports (deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX weekly_reports_tombstone_idx ON weekly_reports (deleted_at) WHERE deleted_at IS NOT NULL;
-- Listen nach Status und Woche.
CREATE INDEX daily_reports_user_status_date_idx ON daily_reports (user_id, status, report_date) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- Idempotenz: bereits verarbeitete Synchronisationsoperationen
-- ---------------------------------------------------------------------------
-- Wird dieselbe Operation (gleiche operation_id) erneut gesendet – z. B. weil die Antwort wegen
-- eines Netzwerkfehlers verloren ging –, liefert der Server das gespeicherte Ergebnis, statt die
-- Operation ein zweites Mal auszuführen. Gespeichert wird nur das Ergebnis (Status, Version,
-- Konfliktgrund), kein Berichtsinhalt.
CREATE TABLE sync_operations (
    user_id      UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    operation_id UUID        NOT NULL,
    device_ref   UUID        REFERENCES devices (id) ON DELETE SET NULL,
    entity_type  VARCHAR(32) NOT NULL,
    entity_id    UUID        NOT NULL,
    request_hash BYTEA       NOT NULL,
    result       JSONB       NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, operation_id)
);
CREATE INDEX sync_operations_created_idx ON sync_operations (created_at);

-- ---------------------------------------------------------------------------
-- Sicherheitsereignisse (technische Audit-Informationen, keine Inhalte)
-- ---------------------------------------------------------------------------
-- Gespeichert werden nur Ereignistyp, Zeitpunkt und technische IDs – keine Passwörter, Tokens,
-- E-Mail-Adressen, IP-Adressen oder Berichtsinhalte.
CREATE TABLE security_events (
    id          BIGSERIAL PRIMARY KEY,
    user_id     UUID        REFERENCES users (id) ON DELETE CASCADE,
    event_type  VARCHAR(40) NOT NULL,
    session_id  UUID,
    device_ref  UUID        REFERENCES devices (id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX security_events_user_idx ON security_events (user_id, created_at DESC);
CREATE INDEX security_events_created_idx ON security_events (created_at);

-- ---------------------------------------------------------------------------
-- Serverzustand (z. B. Untergrenze gültiger Sync-Cursor nach Tombstone-Bereinigung)
-- ---------------------------------------------------------------------------
CREATE TABLE server_state (
    key        VARCHAR(64) PRIMARY KEY,
    value      TEXT        NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Bereinigung abgelaufener Sitzungen und Tokens.
CREATE INDEX sessions_expires_idx ON sessions (expires_at);
CREATE INDEX refresh_tokens_expires_idx ON refresh_tokens (expires_at);
