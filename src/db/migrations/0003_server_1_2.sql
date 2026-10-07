-- Berichtly Server 1.2 – Node.js-Server.
--
-- Rein additiv: Bestehende Daten bleiben unverändert.
--
-- Die Prüfsumme einer Synchronisationsoperation (request_hash) erkennt, ob eine operationId für eine
-- andere Änderung wiederverwendet wird. Server 1.1 (Go) hat sie aus den Rohbytes des Requests
-- berechnet, Server 1.2 (Node.js) aus dem geparsten JSON. hash_format unterscheidet beide Verfahren:
--   1 = Server 1.1 (Bestandseinträge), 2 = Server 1.2.
-- Bei Wiederholungen von Operationen mit Format 1 prüft 1.2 stattdessen Typ und Datensatz-ID.
ALTER TABLE sync_operations
    ADD COLUMN hash_format SMALLINT NOT NULL DEFAULT 1 CHECK (hash_format IN (1, 2));

-- Synchronisationsstatus der Geräte (z. B. Geräte mit Konflikten oder Fehlern finden).
CREATE INDEX devices_user_sync_status_idx ON devices (user_id, sync_status);
