# Changelog

## 1.1.0 – 2026-10-04

Stabile Weiterentwicklung von 1.0 Alpha. Upgrade ohne Datenverlust (docs/UPGRADE.md); alle 1.0-Endpunkte
bleiben unverändert.

### Behobene Fehler
- **Synchronisierung konnte Änderungen überspringen:** Der Abruf las Tages-, Wochenberichte und Profil in drei
  Abfragen ohne gemeinsamen Snapshot. Committete ein anderes Gerät genau dazwischen, sprang der Cursor über eine
  noch nicht sichtbare Änderung. Jetzt ein konsistenter Snapshot (REPEATABLE READ); Regressionstest unter Last.
- Migrationen: Sperre über den gesamten Lauf (vorher konnte das erstmalige Anlegen der Migrationstabelle bei zwei
  gleichzeitig startenden Instanzen kollidieren).
- Log-Zeitstempel immer in UTC.

### Neu
- Geräteverwaltung: Gerät registrieren, abrufen, umbenennen, abmelden; OS-Version; abgemeldete Geräte; Sitzungen
  werden an Geräte gebunden.
- Sitzungen auflisten und beenden, "überall abmelden", Passwort ändern (beendet andere Sitzungen).
- Sicherheitsereignisse (Audit ohne Inhalte), für Benutzer abrufbar.
- Synchronisierung: `POST /sync` (Push + Pull), `POST /sync/complete`, idempotente `operationId`,
  Synchronisationsstatus pro Gerät (NEVER/SUCCESS/FAILED/CONFLICT), Echo-Markierung, Cursor-Epochen.
- Berichte: Herkunft (Clientzeit, lokale ID, erstellendes/letztes Gerät, Operation); Filter nach Jahr, Monat,
  ISO-Woche; `GET /weeks/{isoYear}/{isoWeek}`; `today` in der Wochenübersicht.
- Aufbewahrung und automatische Wartung (Tombstones, Idempotenz-Einträge, Ereignisse, Sitzungen).
- Readiness-Endpunkt `/health/ready`; Docker-Healthcheck und `healthcheck` nutzen ihn.
- CLI: `migrate-status`, `db-check`, `maintenance`, `reset-sync-cursors`.
- Rate Limiting je Endpunkt (Login, Registrierung, Refresh) und zusätzlich pro Konto.
- HTTP: Content-Security-Policy, Cross-Origin-Resource-Policy, HSTS hinter HTTPS-Proxy, Benutzer-ID im Request-Log.
- Server startet nicht mit veraltetem Datenbankschema.
- Dokumentation: UPGRADE.md, BACKUP.md, überarbeitete SYNC.md und vollständige OpenAPI-Spezifikation 1.1.
- Tests: Synchronisationsszenarien, Upgrade 1.0 → 1.1 mit Bestandsdaten, Datums-/Zeitzonenfälle, IDOR,
  Leistungstest mit 300 000 Berichten, Vollständigkeit von OpenAPI und `.env.example`.

## 1.0.0-alpha – 2026-10-04

Erste Version von Berichtly Server als eigenständiges Linux-Backend.

- Statisch gelinkte Linux-Binärdatei (Go) für amd64 und arm64, ohne Laufzeitabhängigkeiten
- PostgreSQL mit eingebetteten, versionierten Migrationen (Prüfsummenkontrolle)
- Versionierte REST-API unter `/api/v1` mit einheitlichem Antwort- und Fehlerformat
- Konten: Registrierung, Login, Logout, Token-Erneuerung (Argon2id, JWT, rotierende Refresh Tokens)
- Profil, Tagesberichte, Wochenberichte, Wochenübersicht (Montag–Sonntag, zeitzonenbewusst)
- Synchronisationsgrundlage: Versionen, Änderungs-Cursor, Tombstones, Konfliktmeldungen, Sync-Status pro Gerät
- Geräteverwaltung (stabile Geräte-IDs, Sitzungen pro Gerät)
- Health-Check, geschützter interner Status, strukturiertes Logging, Request-IDs, Rate Limiting, kontrollierter Shutdown
- systemd-Service mit Härtung, Installationsskript, Docker-Image (distroless), Nginx/Caddy-Vorlagen
- Integrationstests gegen echte PostgreSQL
