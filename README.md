# Berichtly Server 1.0 Alpha

Berichtly Server ist das eigenständige **Linux-Backend** für die Berichtly-Android-App. Er verwaltet
Benutzerkonten, Profile, Tages- und Wochenberichte und stellt eine versionierte REST-API sowie die Grundlage
für die spätere Synchronisierung zwischen Android-Geräten und Server bereit.

> **Status: 1.0 Alpha.** Die Grundlage ist für den produktiven Einsatz aufgebaut (echte PostgreSQL-Datenbank,
> sichere Authentifizierung, Migrationen, Tests), befindet sich aber in einer frühen Phase. Die Android-App
> funktioniert weiterhin vollständig ohne Server – eine Serververbindung ist dort noch nicht eingebaut und nicht
> verpflichtend.

## Was der Server kann

| Bereich | Umfang in 1.0 Alpha |
|---|---|
| Konten | Registrierung, Login, Logout, Token-Erneuerung; Argon2id-Passwort-Hashes; vorübergehende Kontosperre nach Fehlversuchen |
| Tokens | Kurzlebige JWT Access Tokens (15 min), rotierende Refresh Tokens (nur gehasht gespeichert, widerrufbar, Wiederverwendung wird erkannt) |
| Profil | Name, Beruf/Ausbildungsberuf, Betrieb, Abteilung, Ausbilder/in, Ausbildungszeitraum, Schreibstil – genau die Felder der App |
| Tagesberichte | Abrufen, Erstellen, Ändern, Löschen; Filter nach Datum, Zeitraum und Status; Pagination |
| Wochenberichte | Ein aktiver Bericht pro ISO-Woche; Abrufen, Erstellen, Ändern, Löschen |
| Wochenübersicht | Montag bis Sonntag mit Tagesberichten; "aktuelle Woche" in der Zeitzone des Benutzers |
| Synchronisierung | Änderungen seit Cursor abrufen, lokale Änderungen hochladen, Versionen, Tombstones, Konfliktmeldungen, Sync-Status pro Gerät |
| Geräte | Stabile Geräte-IDs, Sitzungen pro Gerät, Geräteliste, Gerät abmelden |
| Betrieb | Health-Check, geschützter interner Status, strukturiertes Logging, Request-IDs, Rate Limiting, kontrollierter Shutdown |
| Auslieferung | Statische Linux-Binärdatei (amd64/arm64), systemd-Service, Docker-Image, Reverse-Proxy-Beispiele |

Noch nicht enthalten (geplant, siehe [Roadmap](#roadmap)): automatische Synchronisierung in der App, grafische
Konfliktauflösung, Passwort ändern/zurücksetzen, E-Mail-Versand, Backups über die API, Push, serverseitige PDFs.
Der Server benötigt **keine KI** und **keine Cloud-Dienste** (kein Google, kein Firebase).

## Technik

- **Go** (Standardbibliothek für HTTP, Routing und Logging) – eine einzige, statisch gelinkte Linux-Binärdatei
  ohne Laufzeitumgebung (kein Java, kein Python, kein Node.js). Typischer Speicherbedarf: ca. 15–30 MB.
- **PostgreSQL 14+** (getestet mit 17) über `pgx` mit Connection-Pool
- Versionierte SQL-Migrationen, in die Binärdatei eingebettet
- **Argon2id** (`golang.org/x/crypto`), **JWT** (`golang-jwt`), strukturiertes Logging mit `log/slog` (Text oder JSON)
- Integrationstests gegen eine echte PostgreSQL-Datenbank

Architektur und Projektstruktur: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

## Installation auf einem Linux-Server (Release-Archiv)

Voraussetzungen: Linux (x86_64 oder arm64) mit systemd, PostgreSQL 14+ (lokal oder im privaten Netz).
Java, Go oder andere Laufzeitumgebungen werden **nicht** benötigt.

```bash
# 1. Archiv auf den Server kopieren und entpacken (amd64 oder arm64)
tar xzf berichtly-server-1.0.0-alpha-linux-amd64.tar.gz
cd berichtly-server-1.0.0-alpha-linux-amd64

# 2. PostgreSQL einrichten (Debian/Ubuntu)
sudo apt install -y postgresql
sudo -u postgres psql -c "CREATE ROLE berichtly LOGIN PASSWORD 'HIER-EIN-STARKES-PASSWORT';"
sudo -u postgres psql -c "CREATE DATABASE berichtly OWNER berichtly ENCODING 'UTF8';"

# 3. Installieren (Systembenutzer, /opt/berichtly-server, Konfiguration, systemd-Unit)
sudo ./deploy/install.sh

# 4. Konfigurieren: DB_PASSWORD und JWT_SECRET setzen (openssl rand -base64 48)
sudo nano /etc/berichtly-server/berichtly-server.env

# 5. Prüfen, migrieren, starten
CONF=/etc/berichtly-server/berichtly-server.env
sudo -u berichtly /opt/berichtly-server/berichtly-server --env-file $CONF check-config
sudo -u berichtly /opt/berichtly-server/berichtly-server --env-file $CONF migrate
sudo systemctl enable --now berichtly-server
systemctl status berichtly-server
curl http://127.0.0.1:8080/api/v1/health
```

Verwalten: `sudo systemctl stop|start|restart berichtly-server`, Logs: `journalctl -u berichtly-server -f`.
Der Dienst läuft als eingeschränkter Benutzer ohne Root-Rechte. HTTPS übernimmt ein Reverse Proxy
(Nginx oder Caddy, Vorlagen in `deploy/`). Ausführlich: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Betrieb mit Docker

```bash
cp .env.example .env          # DB_PASSWORD und JWT_SECRET setzen
docker compose up -d --build
docker compose ps             # beide Dienste "healthy"?
curl http://127.0.0.1:8080/api/v1/health
```

PostgreSQL hat in Docker keine veröffentlichten Ports und hängt nur im internen Netz; der Server ist nur auf
`127.0.0.1` erreichbar. Das Image enthält nur die Binärdatei (distroless, ohne Shell) und läuft als `nonroot`.

## Kommandozeile

```
berichtly-server [--env-file <pfad>] <befehl>
```

| Befehl | Zweck |
|---|---|
| `serve` | Server starten (Standard). SIGTERM/Strg+C: keine neuen Verbindungen, laufende Requests werden beendet, DB-Verbindungen geschlossen. |
| `migrate` | Datenbankmigrationen ausführen und beenden |
| `check-config` | Konfiguration prüfen und ohne Secrets anzeigen |
| `healthcheck` | `GET /api/v1/health` des laufenden Servers; Exit-Code 0 = gesund (Docker, Monitoring, Skripte) |
| `seed-dev` | Entwicklungskonto mit wenigen, gekennzeichneten Beispieldaten – **nur** bei `APP_ENV=development`, nie automatisch |
| `version`, `help` | Version bzw. Hilfe |

`--env-file` lädt eine `.env`-Datei; echte Umgebungsvariablen haben Vorrang.

## Konfiguration

Ausschließlich über **Umgebungsvariablen**; alle Variablen mit Erklärung stehen in [.env.example](.env.example).
Fehlende oder offensichtlich schwache Secrets verhindern den Start – es gibt keine eingebauten Standard-Secrets.

| Variable | Bedeutung |
|---|---|
| `APP_ENV` | `development`, `test` oder `production` (Standard: `production`) |
| `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, **`DB_PASSWORD`**, `DB_SSLMODE` | Datenbankverbindung (oder `DB_URL`) |
| **`JWT_SECRET`** | Base64, mindestens 32 Byte Zufall: `openssl rand -base64 48` |
| `SERVER_HOST`, `SERVER_PORT` | Standard `127.0.0.1:8080` |
| `TRUST_PROXY` | `true` nur hinter einem Reverse Proxy (echte Client-IP für Rate Limiting) |
| `ACCESS_TOKEN_TTL_MINUTES`, `REFRESH_TOKEN_TTL_DAYS` | Token-Laufzeiten (15 min / 30 Tage) |
| `REGISTRATION_ENABLED` | Registrierung erlauben |
| `CORS_ALLOWED_ORIGINS` | Leer = CORS aus (die App braucht keins); `*` ist in Produktion verboten |
| `LOG_LEVEL`, `LOG_FORMAT` | `debug`/`text` in Entwicklung, `info`/`json` in Produktion |
| `API_DOCS_ENABLED` | Swagger UI unter `/api/docs` (Standard: an in Entwicklung, aus in Produktion) |
| `INTERNAL_STATUS_TOKEN` | Aktiviert `/internal/status` (leer = deaktiviert) |

## Migrationen

Schemaänderungen erfolgen ausschließlich über versionierte SQL-Dateien in `internal/store/migrations`
(`0002_beschreibung.sql`, …). Sie sind in die Binärdatei eingebettet und werden beim Start
(`DB_MIGRATE_ON_START=true`) oder mit `berichtly-server migrate` angewendet – jede in einer eigenen Transaktion,
geschützt gegen parallele Ausführung. Bereits angewendete Migrationen werden per Prüfsumme überwacht: Wird
eine nachträglich verändert, bricht der Server mit einer klaren Meldung ab. Änderungen immer als neue Datei.

## Entwicklung und Bauen

Voraussetzung: Go 1.27+ (nur zum Bauen; auf dem Server nicht nötig).

```bash
make build          # bin/berichtly-server (statisch, Linux)
make run            # mit .env starten
make test-db        # Wegwerf-PostgreSQL in Docker für Tests (127.0.0.1:55432)
make test           # alle Tests inkl. Integrationstests
make lint           # gofmt + go vet
make release        # dist/berichtly-server-<version>-linux-{amd64,arm64}.tar.gz + SHA256SUMS
make docker         # Container-Image
```

### Tests

Die Integrationstests laufen über echtes HTTP durch alle Schichten bis in eine **echte PostgreSQL-Datenbank**.
Sie benötigen `BERICHTLY_TEST_DATABASE_URL` mit einer Testdatenbank, deren Name `test` enthält (Schutz vor
versehentlichem Löschen); `make test-db` stellt eine bereit. Ohne diese Variable werden die Integrationstests
übersprungen, die Unit-Tests laufen trotzdem.

Abgedeckt: Registrierung, Login, Token-Rotation und -Wiederverwendung, Logout, fehlende/ungültige/fremd
signierte/abgelaufene Tokens, Rate Limiting, Kontosperre, Zugriffsschutz zwischen Benutzern, Profil, Tages- und
Wochenberichte, Wochenberechnung inkl. Zeitzonen und Jahreswechsel, Synchronisierung inkl. Konflikten und
Tombstones, Health-/Statusbereich, CORS, Request-Limits, Datenbank-Constraints und Migrationen.

## API im Überblick

Basis-URL `/api/v1`, JSON, Authentifizierung per `Authorization: Bearer <accessToken>`.

```
GET    /health, /health/live                           öffentlich
POST   /auth/register | /auth/login | /auth/refresh    öffentlich, rate-limitiert
POST   /auth/logout
GET    /account                  PATCH /account
GET    /profile                  PUT   /profile
GET    /daily-reports            POST  /daily-reports
GET    /daily-reports/{id}       PUT   /daily-reports/{id}     DELETE /daily-reports/{id}?version=N
GET    /weekly-reports           POST  /weekly-reports
GET    /weekly-reports/{id}      PUT   /weekly-reports/{id}    DELETE /weekly-reports/{id}?version=N
GET    /weeks/current            GET   /weeks/{date}
GET    /sync/changes?cursor=…    POST  /sync/push              GET /sync/status
GET    /devices                  DELETE /devices/{id}
```

Antwortformat, Fehlercodes und geplante Android-Anbindung: [docs/API.md](docs/API.md) ·
Synchronisationskonzept: [docs/SYNC.md](docs/SYNC.md) · Sicherheit: [docs/SECURITY.md](docs/SECURITY.md) ·
OpenAPI-Spezifikation: [api/openapi.yaml](api/openapi.yaml) (im Entwicklungsmodus auch unter `/api/docs`).

## Roadmap

Geplant für 1.1 / Beta (bewusst noch nicht implementiert):

- Optionale Anbindung in der Android-App und Hintergrund-Synchronisierung
- Benutzerentscheidung bei Konflikten in der App
- Passwort ändern, Passwort-Reset, Konto löschen über die API
- Berichtsversionen (Verlauf wie `report_versions` in der App)
- Server-Backups und Export, Metriken-Endpunkt (z. B. Prometheus), Admin-Befehle für die Kontoverwaltung
- Push-Benachrichtigungen und serverseitige PDF-Erzeugung als optionale Erweiterungen
