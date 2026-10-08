# Changelog

## 1.2.1 – 2026-10-08

Betrieb ohne Domain. API und Datenbank unverändert, keine Migration.

- **HTTPS über die IP-Adresse:** Ohne Domain erzeugt die Installation ein eigenes Zertifikat für die IP
  (`deploy/tls-selfsigned.sh`, EC P-256, 10 Jahre) und richtet Nginx mit der neuen Vorlage
  `berichtly-ip.conf.template` ein. Die App vertraut dem Server über den Fingerabdruck des Schlüssels
  (Certificate Pinning); bei Verlängerung oder neuer IP bleibt der Schlüssel und damit der Fingerabdruck gleich.
- Neuer Befehl `berichtly-server tls-pin`: Adresse, Fingerabdruck und Ablaufdatum; `--uri` liefert die
  Verbindungsdaten für die App (`berichtly://server?url=…&pin=…`), die Installation zeigt sie als QR-Code.
- `install-from-github.sh` und `deploy/setup.sh` wählen ohne Angaben automatisch den Betrieb über die IP – keine
  Rückfragen mehr. Eine gespeicherte Domain ohne Zertifikat wird dabei verworfen. Mit Domain wie bisher.
- `scripts/install-on-server.ps1`: `-Domain`/`-Email` sind optional.
- Docker Compose: `NGINX_CONFIG=ip` mit Zertifikat vom Host (`TLS_DIR`).
- Doku: HTTPS.md (Betrieb ohne Domain), API.md (Pinning in der Android-App mit OkHttp), BACKUP.md (TLS-Schlüssel
  sichern), OpenAPI (Server ohne Domain).
- Tests: Nginx-Full-Stack-Tests zusätzlich in der Betriebsart `ip` (nur mit richtigem Pin, falscher Pin und
  Verbindungen ohne Pin werden abgelehnt); Unit-Test für Pin-Stabilität und Verbindungsdaten.

## 1.2.0 – 2026-10-07

Neue Laufzeit und neuer öffentlicher Zugang – gleiche API, gleiche Datenbank. Upgrade von 1.1 ohne Datenverlust;
angemeldete Apps bleiben angemeldet (docs/UPGRADE.md).

### Laufzeit: Node.js
- Server vollständig auf **Node.js 24 LTS** portiert (TypeScript, direkt von Node.js ausgeführt; Fastify 5,
  node-postgres). Alle 39 Endpunkte von `/api/v1` mit identischen Feldern, Statuscodes und Fehlercodes; ein Test
  gleicht Routen und OpenAPI in beide Richtungen ab.
- Kompatibel mit Bestandsdaten aus 1.1: Argon2id-Hashes (jetzt `node:crypto`), JWT- und Refresh-Token-Format,
  Sync-Cursor, Migrationen 0001/0002 byteidentisch.
- Migration `0003_server_1_2.sql` (additiv): `sync_operations.hash_format` – Wiederholungen von Operationen, die 1.1
  verarbeitet hat, werden weiterhin erkannt; Index für den Synchronisationsstatus der Geräte.
- Standardport jetzt `3000` (nur `127.0.0.1`); vorhandene Konfigurationen mit 8080 funktionieren weiter.
- Neuer Fehlercode `SERVICE_UNAVAILABLE` (503 mit `Retry-After`): während des Shutdowns und bei nicht erreichbarer
  Datenbank (vorher 500).
- Kontrollierter Shutdown: neue Anfragen 503 mit `Connection: close`, laufende werden beendet, Keep-Alive-
  Verbindungen geschlossen, danach der Datenbank-Pool.
- Request-Log zusätzlich mit `proto` (http/https zwischen App und Nginx).

### Öffentlicher Zugang: Nginx
- Nginx ist der einzige öffentliche Dienst: Vorlagen für Produktion (HTTPS) und Entwicklung/Ersteinrichtung (HTTP),
  Domain nur als Variable. TLS 1.2/1.3, HTTP→HTTPS (308), HSTS (genau einmal), Body-Limit 1 MiB,
  Grund-Rate-Limit pro IP (strenger für Auth), Keep-Alive zum Upstream, Timeouts, `/internal/` gesperrt.
- Weitergabe von `X-Forwarded-For`, `X-Forwarded-Proto`, `X-Real-IP` und `X-Request-ID`; dieselbe Request-ID in
  Nginx- und Server-Log. Fehler von Nginx im Fehlerformat der API.
- Let's Encrypt über Certbot (Webroot) mit dokumentierter, über den Certbot-Timer automatischer Erneuerung.
- `deploy/install-nginx.sh` rendert die Vorlage, prüft mit `nginx -t` und aktiviert sie.
- Caddy-Vorlage entfernt (Nginx ist der unterstützte Zugang).

### Docker Compose
- Drei Dienste: `nginx` (einziger mit veröffentlichten Ports), `server` und `db` im internen Netz ohne
  Internetzugang. Healthchecks (`pg_isready`, Readiness, Nginx), Startreihenfolge über `depends_on`.
- Entwicklungsdatei `docker-compose.dev.yml` (HTTP auf 127.0.0.1, Datenbank-Port nur lokal); ohne sie gilt immer
  die Produktionskonfiguration. Datenbank-Volume aus 1.1 wird weiterverwendet.
- Server-Image auf `node:24-alpine`, Benutzer `node`, schreibgeschützt, ohne Capabilities.

### Betrieb und Dokumentation
- systemd-Unit für Node.js (EnvironmentFile, keine Secrets, Autostart, Härtung), `install.sh` prüft Node.js ≥ 24.
- `.env.example` vollständig inklusive Domain- und Nginx-Variablen, mit sicheren Produktionswerten.
- Neue Dokumente: HTTPS.md, OPERATIONS.md (Logs, Log-Rotation über journald/logrotate/Docker, Monitoring);
  DEPLOYMENT.md, UPGRADE.md (1.1 → 1.2), ARCHITECTURE.md, SECURITY.md und OpenAPI 1.2 (Betrieb hinter Nginx/HTTPS)
  aktualisiert.
- Release-Archiv `berichtly-server-<version>.tar.gz` inklusive Laufzeitabhängigkeiten (keine nativen Module,
  für amd64 und arm64 gleich).

### Tests
- Alle Tests auf `node:test` portiert: Unit-Tests, Integrationstests gegen PostgreSQL, Upgrade 1.0 → 1.1 → 1.2 mit
  Bestandsdaten aus dem Go-Server, Leistungstest (300 000 Berichte, opt-in).
- Neu: Full-Stack-Tests PostgreSQL → Node.js → echtes Nginx über HTTP und HTTPS (alle Methoden, Authorization,
  X-Forwarded-For/-Proto, 413/404/429, Umleitung, TLS-Versionen), kontrollierter Shutdown, Client-IP hinter dem Proxy.
- Behoben (durch die Nginx-Tests gefunden): Pfade mit Dateiendung (`/index.html`) erhielten von Nginx `text/html`
  statt JSON; `/api` ohne Schrägstrich wurde umgeleitet statt mit 404 beantwortet.

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
