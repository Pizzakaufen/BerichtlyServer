# Berichtly Server 1.1

Berichtly Server ist das eigenständige **Linux-Backend** für die Berichtly-Android-App. Er verwaltet
Benutzerkonten, Geräte, Profile, Tages- und Wochenberichte und stellt eine versionierte REST-API sowie ein
vollständiges Synchronisationsprotokoll für mehrere Android-Geräte pro Konto bereit.

> **Status: 1.1.** Stabile Weiterentwicklung von 1.0 Alpha: Geräte- und Sitzungsverwaltung, idempotente
> Synchronisierung mit Konflikterkennung, Synchronisationsstatus pro Gerät, Aufbewahrungsstrategie für
> Löschungen, Sicherheitsereignisse. Bestehende 1.0-Installationen lassen sich ohne Datenverlust aktualisieren
> ([docs/UPGRADE.md](docs/UPGRADE.md)). Die Android-App (Berichtly 2.2) funktioniert weiterhin ohne Server; ein
> API-Client in der App ist der nächste Schritt.

## Funktionen

| Bereich | Umfang |
|---|---|
| Konten | Registrierung, Login, Logout, "überall abmelden", Passwort ändern; Argon2id; vorübergehende Kontosperre |
| Tokens | JWT Access Tokens (15 min), rotierende Refresh Tokens (nur gehasht gespeichert, widerrufbar, Wiederverwendung beendet die Sitzung) |
| Sitzungen | Aktive Sitzungen auflisten und einzeln beenden; Passwortänderung beendet alle anderen Sitzungen |
| Geräte | Mehrere Android-Geräte pro Konto, stabile Geräte-IDs, Name/Plattform/OS-/App-Version, letzte Aktivität, Synchronisationsstatus, Gerät abmelden |
| Profil | Name, Beruf/Ausbildungsberuf, Betrieb, Abteilung, Ausbilder/in, Ausbildungszeitraum, Schreibstil – die Felder der App |
| Berichte | Tages- und Wochenberichte mit stabilen IDs, Versionen, Server- und Clientzeit, Herkunft (Gerät, lokale ID, Operation); Filter nach Datum, Zeitraum, Monat, Jahr, ISO-Woche, Status; Pagination |
| Wochen | Montag–Sonntag, "aktuelle Woche" in der Zeitzone des Benutzers (Sommer-/Winterzeit, Jahreswechsel getestet), Abruf per Datum oder ISO-Woche |
| Synchronisierung | Push + Pull in einem Schritt, Cursor-Pagination, idempotente Operationen (`operationId`), Konflikterkennung ohne Last-Write-Wins, Tombstones, Abschlussmeldung und Status pro Gerät |
| Sicherheit | Strikte Datentrennung pro Benutzer, Rate Limiting je Endpunkt und pro Konto, Sicherheitsereignisse ohne Inhalte, CORS nur explizit, Security-Header |
| Betrieb | Health/Liveness/Readiness, interner Status, strukturierte JSON-Logs mit Request-ID, automatische Wartung, kontrollierter Shutdown |
| Auslieferung | Statische Linux-Binärdatei (amd64/arm64), systemd-Service, Docker-Image (distroless, nonroot), Docker Compose |

Der Server benötigt **keine KI** (die KI bleibt in der App) und **keine Cloud-Dienste** (kein Google, kein Firebase).

## Technik

- **Go** (Standardbibliothek für HTTP, Routing, Logging) – eine statisch gelinkte Linux-Binärdatei ohne
  Laufzeitumgebung; gemessener Speicherbedarf im Betrieb ca. 50 MB (davon rund 20 MB Heap).
- **PostgreSQL 14+** (getestet mit 17) über `pgx` mit Connection-Pool; versionierte, eingebettete Migrationen.
- Argon2id (`golang.org/x/crypto`), JWT (`golang-jwt`), `log/slog`.
- Integrationstests gegen echte PostgreSQL, inklusive Upgrade-Test 1.0 → 1.1 und Leistungstest mit 300 000 Berichten.

Architektur: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

## Installation auf einem Linux-Server (Release-Archiv)

Voraussetzungen: Linux (x86_64 oder arm64) mit systemd, PostgreSQL 14+. Keine weitere Laufzeitumgebung nötig.

```bash
tar xzf berichtly-server-1.1.0-linux-amd64.tar.gz
cd berichtly-server-1.1.0-linux-amd64

# PostgreSQL einrichten (Debian/Ubuntu)
sudo apt install -y postgresql
sudo -u postgres psql -c "CREATE ROLE berichtly LOGIN PASSWORD 'HIER-EIN-STARKES-PASSWORT';"
sudo -u postgres psql -c "CREATE DATABASE berichtly OWNER berichtly ENCODING 'UTF8';"

# Installieren: Systembenutzer, /opt/berichtly-server, Konfiguration, systemd-Unit
sudo ./deploy/install.sh

# Konfigurieren: mindestens DB_PASSWORD und JWT_SECRET (openssl rand -base64 48)
sudo nano /etc/berichtly-server/berichtly-server.env

CONF=/etc/berichtly-server/berichtly-server.env
sudo -u berichtly /opt/berichtly-server/berichtly-server --env-file $CONF check-config
sudo -u berichtly /opt/berichtly-server/berichtly-server --env-file $CONF db-check   # meldet "Schema nicht aktuell" vor migrate
sudo -u berichtly /opt/berichtly-server/berichtly-server --env-file $CONF migrate
sudo systemctl enable --now berichtly-server        # startet auch automatisch nach einem Neustart
curl http://127.0.0.1:8080/api/v1/health/ready
```

Verwalten: `sudo systemctl stop|start|restart berichtly-server`, Logs: `journalctl -u berichtly-server -f`.
HTTPS über Reverse Proxy (Vorlagen für Nginx und Caddy in `deploy/`). Ausführlich: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).
Update von 1.0 Alpha: [docs/UPGRADE.md](docs/UPGRADE.md). Backup: [docs/BACKUP.md](docs/BACKUP.md).

## Betrieb mit Docker Compose

```bash
cp .env.example .env          # DB_PASSWORD und JWT_SECRET setzen
docker compose up -d --build
docker compose ps             # beide Dienste "healthy"?
curl http://127.0.0.1:8080/api/v1/health/ready
```

PostgreSQL hat keine veröffentlichten Ports und hängt nur im internen Netz; der Server ist nur auf `127.0.0.1`
erreichbar. Das Server-Image enthält nur die Binärdatei (distroless, ohne Shell) und läuft als `nonroot` mit
schreibgeschütztem Dateisystem. Daten liegen im Volume `db-data` und überstehen Neustarts und Updates.

## Kommandozeile

```
berichtly-server [--env-file <pfad>] <befehl>
```

| Befehl | Zweck |
|---|---|
| `serve` | Server starten (Standard). SIGTERM/Strg+C: keine neuen Verbindungen, laufende Requests werden beendet, DB-Pool geschlossen |
| `migrate` | Datenbankmigrationen ausführen |
| `migrate-status` | Stand jeder Migration (angewendet, ausstehend, nachträglich verändert) |
| `db-check` | Datenbankverbindung, PostgreSQL-Version, Antwortzeit und Schema-Version prüfen |
| `check-config` | Konfiguration prüfen und ohne Secrets anzeigen |
| `healthcheck` | Readiness des laufenden Servers (Exit-Code 0 = bereit) – für Docker, Monitoring, Skripte |
| `maintenance` | Wartung sofort ausführen (Aufbewahrungsfristen anwenden) |
| `reset-sync-cursors` | Nach dem Einspielen eines Backups: alle Geräte einmal vollständig neu synchronisieren lassen |
| `seed-dev` | Entwicklungskonto mit gekennzeichneten Beispieldaten – **nur** bei `APP_ENV=development` |
| `version`, `help` | Version bzw. Hilfe |

## Konfiguration

Ausschließlich über **Umgebungsvariablen**; alle Variablen sind in [.env.example](.env.example) dokumentiert (ein
Test stellt sicher, dass dort keine fehlt). Fehlende oder offensichtlich schwache Secrets verhindern den Start.

| Variable | Bedeutung |
|---|---|
| `APP_ENV` | `development`, `test` oder `production` (Standard: `production`) |
| `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, **`DB_PASSWORD`**, `DB_SSLMODE` | Datenbankverbindung (oder `DB_URL`) |
| **`JWT_SECRET`** | Base64, mindestens 32 Byte Zufall |
| `SERVER_HOST`, `SERVER_PORT`, `TRUST_PROXY` | Standard `127.0.0.1:8080`; `TRUST_PROXY=true` nur hinter Reverse Proxy |
| `RATE_LIMIT_*` | Login, Login pro Konto, Registrierung, Refresh, übrige API |
| `TOMBSTONE_RETENTION_DAYS`, `SYNC_OPERATION_RETENTION_DAYS`, `SECURITY_EVENT_RETENTION_DAYS`, `SESSION_RETENTION_DAYS`, `MAINTENANCE_INTERVAL_HOURS` | Aufbewahrung und Wartung |
| `CORS_ALLOWED_ORIGINS` | Leer = CORS aus (die App braucht keins); `*` in Produktion verboten |
| `LOG_LEVEL`, `LOG_FORMAT`, `API_DOCS_ENABLED`, `INTERNAL_STATUS_TOKEN` | Logging, Swagger UI, interner Status |

## API im Überblick

Basis `/api/v1`, JSON, `Authorization: Bearer <accessToken>`. Vollständig in [api/openapi.yaml](api/openapi.yaml)
(Entwicklungsmodus: Swagger UI unter `/api/docs`). Ein Test stellt sicher, dass jede Route dokumentiert ist.

```
GET    /health  /health/live  /health/ready                       öffentlich
POST   /auth/register  /auth/login  /auth/refresh                  öffentlich, rate-limitiert
POST   /auth/logout  /auth/logout-all
GET    /account   PATCH /account   POST /account/password   GET /account/security-events
GET    /sessions  DELETE /sessions/{id}
GET    /profile   PUT /profile
GET    /daily-reports   POST /daily-reports   GET|PUT|DELETE /daily-reports/{id}
GET    /weekly-reports  POST /weekly-reports  GET|PUT|DELETE /weekly-reports/{id}
GET    /weeks/current   /weeks/{date}   /weeks/{isoYear}/{isoWeek}
POST   /sync   POST /sync/complete   GET /sync/changes   POST /sync/push   GET /sync/status
POST   /devices   GET /devices   GET|PATCH|DELETE /devices/{id}
```

Antwortformat und Android-Anbindung: [docs/API.md](docs/API.md) · Synchronisationsprotokoll: [docs/SYNC.md](docs/SYNC.md) ·
Sicherheit: [docs/SECURITY.md](docs/SECURITY.md)

## Entwicklung, Tests, Bauen

Voraussetzung: Go 1.27+ (nur zum Bauen).

```bash
make test-db        # Wegwerf-PostgreSQL in Docker (127.0.0.1:55432)
make test           # alle Tests inkl. Integrationstests
make test-perf      # Leistungstest mit 300 000 Berichten
make lint           # gofmt + go vet
make build          # bin/berichtly-server
make release        # dist/berichtly-server-<version>-linux-{amd64,arm64}.tar.gz + SHA256SUMS
make docker         # Container-Image
```

Integrationstests benötigen `BERICHTLY_TEST_DATABASE_URL` mit einer Datenbank, deren Name `test` enthält; ohne
diese Variable werden sie übersprungen, die Unit-Tests laufen trotzdem.

Abgedeckt sind u. a.: Registrierung, Login, Token-Erneuerung und -Wiederverwendung, Logout, "überall abmelden",
Passwortänderung, Sitzungen, Geräteverwaltung, Benutzerisolierung (inkl. manipulierter IDs), Profil, Berichte
(Erstellen, Bearbeiten, Löschen, Pagination, Filter), Datumslogik (Sommer-/Winterzeit, Jahreswechsel, ISO-Wochen),
Synchronisationsszenarien (neues Gerät, bestehendes Berichtsheft, mehrere Geräte, Löschung, Wiederholung,
Netzwerkabbruch, echter Konflikt, gleichzeitige Übertragung, abgelaufener Cursor, Wiederherstellung), Wartung,
Migrationen (Upgrade 1.0 → 1.1 mit Bestandsdaten, Erkennung veränderter Migrationen) und Rate Limiting.

## Roadmap (nach 1.1)

- API-Client und optionale Synchronisierung in Berichtly 2.2 (Android)
- Konto löschen und Datenexport über die API, Passwort-Reset per E-Mail
- Berichtsversionen (Verlauf wie `report_versions` in der App)
- Metriken-Endpunkt (z. B. Prometheus), Admin-Befehle zur Kontoverwaltung
- Optionale Erweiterungen: Push-Benachrichtigungen, serverseitige PDF-Erzeugung
