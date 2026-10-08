# Berichtly Server 1.2.1

Berichtly Server ist das eigenständige **Linux-Backend** für die Berichtly-Android-App. Er verwaltet
Benutzerkonten, Geräte, Profile, Tages- und Wochenberichte und stellt eine versionierte REST-API sowie ein
vollständiges Synchronisationsprotokoll für mehrere Android-Geräte pro Konto bereit.

> **Status: 1.2.1.** Neu: Betrieb **ohne Domain** über die IP-Adresse (HTTPS mit eigenem Zertifikat und
> Fingerabdruck für die App). Seit 1.2 läuft der Server auf **Node.js LTS** hinter **Nginx** als einzigem öffentlichen Zugang
> (HTTPS, TLS 1.2/1.3, HSTS, Rate Limiting). API, Datenbank und Verhalten sind identisch mit 1.1 – bestehende
> Installationen werden ohne Datenverlust aktualisiert, angemeldete Apps bleiben angemeldet
> ([docs/UPGRADE.md](docs/UPGRADE.md)). Die Android-App (Berichtly 2.2) funktioniert weiterhin ohne Server; ein
> API-Client in der App ist der nächste Schritt.

## Aufbau

```
Android-App ──HTTPS──▶ Nginx (einziger öffentlicher Dienst, Port 443/80)
                         │  TLS 1.2/1.3 · HSTS · HTTP→HTTPS · Body-Limit 1 MiB · Grund-Rate-Limit
                         │  /api/* → Node.js · /internal/* und alles andere → 404
                         ▼
                       Node.js 24 LTS (nur 127.0.0.1:3000 bzw. internes Docker-Netz)
                         │  Fastify · Auth · Validierung · Sync · feines Rate Limiting
                         ▼
                       PostgreSQL (nur localhost bzw. internes Docker-Netz, nie öffentlich)
```

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
| Sicherheit | Strikte Datentrennung pro Benutzer, Rate Limiting in Nginx und Node.js, Sicherheitsereignisse ohne Inhalte, CORS nur explizit, Security-Header, HTTPS über Nginx |
| Betrieb | Health/Liveness/Readiness, interner Status, strukturierte JSON-Logs mit durchgehender Request-ID (Nginx → Node.js), automatische Wartung, kontrollierter Shutdown |
| Auslieferung | systemd-Dienst (Node.js) + Nginx, oder Docker Compose mit drei Diensten (nginx, server, db) |

Der Server benötigt **keine KI** (die KI bleibt in der App) und **keine Cloud-Dienste** (kein Google, kein Firebase,
kein Redis). Einzige Datenbank ist PostgreSQL.

## Technik

- **Node.js 24 LTS** führt den TypeScript-Quellcode direkt aus (Type Stripping) – kein Build-Schritt.
  Argon2id kommt aus `node:crypto` (keine nativen Module).
- **Fastify 5** (HTTP), **node-postgres** (`pg`, Connection-Pool, ausschließlich parametrisierte Abfragen).
  Das sind die einzigen Laufzeitabhängigkeiten.
- **PostgreSQL 14+** (getestet mit 17); versionierte Migrationen mit Prüfsummen – dieselben wie in 1.1.
- **Nginx** (getestet mit 1.30) als Reverse Proxy und TLS-Endpunkt; Let's Encrypt über Certbot.
- Tests mit `node:test` gegen echte PostgreSQL und echtes Nginx (HTTP und HTTPS).

Architektur: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

## Installation in einem Schritt (empfohlen)

Voraussetzung: ein Debian- oder Ubuntu-Server (z. B. ein gemieteter VPS). **Eine Domain ist nicht nötig.**

Auf dem Server als root diesen einen Befehl ausführen – es gibt keine Rückfragen:

```bash
curl -fsSL https://raw.githubusercontent.com/Pizzakaufen/BerichtlyServer/main/install-from-github.sh | sh
```

Am Ende zeigt die Installation die **Adresse** (`https://<IP-Adresse>`) und den **Fingerabdruck** des Servers an,
zusätzlich als QR-Code. Beides trägt man in der App ein (bzw. scannt den QR-Code). Die Verbindung ist mit HTTPS
verschlüsselt; die App akzeptiert nur genau diesen Server (Certificate Pinning, siehe [docs/HTTPS.md](docs/HTTPS.md)).
Später erneut anzeigen: `berichtly-server tls-pin`.

**Update:** denselben Befehl erneut ausführen. Daten, Passwörter, Schlüssel und der Fingerabdruck bleiben erhalten.

Varianten:

```bash
# bestimmte IP-Adresse verwenden (z. B. wenn der Server mehrere hat)
curl -fsSL https://raw.githubusercontent.com/Pizzakaufen/BerichtlyServer/main/install-from-github.sh | sh -s -- 203.0.113.10
# mit eigener Domain und Let's-Encrypt-Zertifikat (DNS-Eintrag muss auf den Server zeigen)
curl -fsSL https://raw.githubusercontent.com/Pizzakaufen/BerichtlyServer/main/install-from-github.sh | sh -s -- berichtly.example.de admin@example.de
```

Ist das Repository privat, funktioniert der Download über `raw.githubusercontent.com` nur mit Token. Dann zuerst den
Token in eine Variable lesen (erscheint so nicht im Verlauf) und mitgeben:

```bash
read -rs GITHUB_TOKEN && export GITHUB_TOKEN
curl -fsSL -H "Authorization: Bearer $GITHUB_TOKEN" https://raw.githubusercontent.com/Pizzakaufen/BerichtlyServer/main/install-from-github.sh | sh
```

Von Windows aus mit dem selbst gebauten Paket (`dist/`):

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-on-server.ps1 -Server <SERVER-IP>
```

Oder direkt auf dem Server im entpackten Paket: `sudo sh deploy/setup.sh` (ohne Domain) bzw.
`sudo sh deploy/setup.sh <domain> <e-mail>`.

`deploy/setup.sh` installiert Node.js 24, PostgreSQL und Nginx, legt die Datenbank an, erzeugt zufällige Passwörter
und Schlüssel (nur in `/etc/berichtly-server/`), startet den Dienst, öffnet die Firewall (ufw) und aktiviert HTTPS –
ohne Domain mit eigenem Zertifikat für die IP-Adresse, mit Domain über Let's Encrypt.

## Schritt für Schritt: Linux-Server (systemd)

Voraussetzungen: Debian 12 / Ubuntu 24.04 o. ä. mit systemd, Node.js 24 LTS, PostgreSQL, Nginx, eine Domain mit
DNS-Eintrag auf den Server. Ausführlich: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md), HTTPS: [docs/HTTPS.md](docs/HTTPS.md).

```bash
tar xzf berichtly-server-<version>.tar.gz && cd berichtly-server-<version>

# PostgreSQL (nur localhost)
sudo -u postgres psql -c "CREATE ROLE berichtly LOGIN PASSWORD 'HIER-EIN-STARKES-PASSWORT';"
sudo -u postgres psql -c "CREATE DATABASE berichtly OWNER berichtly ENCODING 'UTF8';"

# Node.js-Server: Systembenutzer, /opt/berichtly-server, Konfiguration, systemd-Unit
sudo ./deploy/install.sh
sudo nano /etc/berichtly-server/berichtly-server.env      # DB_PASSWORD, JWT_SECRET (openssl rand -base64 48)
sudo -u berichtly berichtly-server --env-file /etc/berichtly-server/berichtly-server.env check-config
sudo systemctl enable --now berichtly-server
curl http://127.0.0.1:3000/api/v1/health/ready

# Nginx + HTTPS (Domain nur hier angeben)
sudo ./deploy/install-nginx.sh berichtly.example.de http          # Ersteinrichtung für Let's Encrypt
sudo certbot certonly --webroot -w /var/www/certbot -d berichtly.example.de \
     --deploy-hook "systemctl reload nginx"
sudo ./deploy/install-nginx.sh berichtly.example.de https         # Produktionsbetrieb
curl https://berichtly.example.de/api/v1/health
```

Dienste verwalten:

```bash
sudo systemctl status|start|stop|restart berichtly-server     # Node.js-Server
sudo systemctl status|reload|restart nginx                     # nach Konfigurationsänderungen: reload
sudo systemctl status|restart postgresql
journalctl -u berichtly-server -f                              # Server-Logs (JSON)
```

## Schnellstart: Docker Compose

```bash
cp .env.example .env          # DB_PASSWORD, JWT_SECRET und BERICHTLY_DOMAIN setzen
# Zertifikat auf dem Host beziehen (docs/HTTPS.md, Abschnitt Docker), dann:
docker compose up -d --build
docker compose ps             # nginx, server und db "healthy"?
curl https://IHRE-DOMAIN/api/v1/health
```

Nur Nginx veröffentlicht Ports (80/443). Node.js und PostgreSQL hängen im internen Netz `backend` ohne
Port-Freigabe und ohne Internetzugang. Daten liegen im Volume `db-data` (wie in 1.1).

Lokale Entwicklung mit Docker (HTTP ohne TLS auf `127.0.0.1:8080`, Datenbank auf `127.0.0.1:5432`):

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
curl http://127.0.0.1:8080/api/v1/health
```

## Kommandozeile

```
berichtly-server [--env-file <pfad>] <befehl>        # bzw. node src/cli.ts …
```

| Befehl | Zweck |
|---|---|
| `serve` | Server starten (Standard). SIGTERM/Strg+C: neue Anfragen erhalten 503, laufende werden beendet, DB-Pool geschlossen |
| `migrate` | Datenbankmigrationen ausführen |
| `migrate-status` | Stand jeder Migration (angewendet, ausstehend, nachträglich verändert) |
| `db-check` | Datenbankverbindung, PostgreSQL-Version, Antwortzeit und Schema-Version prüfen |
| `check-config` | Konfiguration prüfen und ohne Secrets anzeigen |
| `healthcheck` | Readiness des laufenden Servers (Exit-Code 0 = bereit) – für Docker, Monitoring, Skripte |
| `maintenance` | Wartung sofort ausführen (Aufbewahrungsfristen anwenden) |
| `reset-sync-cursors` | Nach dem Einspielen eines Backups: alle Geräte einmal vollständig neu synchronisieren lassen |
| `tls-pin` | Adresse und Fingerabdruck (Pin) für die App anzeigen, `--uri` für den QR-Code (Betrieb ohne Domain) |
| `seed-dev` | Entwicklungskonto mit gekennzeichneten Beispieldaten – **nur** bei `APP_ENV=development` |
| `version`, `help` | Version bzw. Hilfe |

## Konfiguration

Ausschließlich über **Umgebungsvariablen**; alle Variablen (Server, Datenbank, Nginx/Domain) sind in
[.env.example](.env.example) dokumentiert – ein Test stellt sicher, dass dort keine fehlt und die Datei eine gültige
Konfiguration ergibt. Die Beispielwerte sind für den **Produktionsbetrieb** voreingestellt; Secrets fehlen bewusst,
und fehlende oder schwache Secrets verhindern den Start.

| Variable | Bedeutung |
|---|---|
| `APP_ENV` | `production` (Standard), `development` oder `test` |
| `BERICHTLY_DOMAIN` | Öffentliche Domain (nur für Nginx; steht nirgends fest im Code) |
| `NGINX_CONFIG`, `NGINX_HTTP_PORT`, `NGINX_HTTPS_PORT`, `LETSENCRYPT_DIR`, `CERTBOT_WEBROOT` | Nur Docker Compose |
| `SERVER_HOST`, `SERVER_PORT`, `TRUST_PROXY` | Standard `127.0.0.1:3000`; `TRUST_PROXY=true` hinter Nginx |
| `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, **`DB_PASSWORD`**, `DB_SSLMODE`, `DB_SSL_CA_FILE` | Datenbankverbindung (oder `DB_URL`) |
| **`JWT_SECRET`** | Base64, mindestens 32 Byte Zufall |
| `MAX_REQUEST_BODY_BYTES`, `SHUTDOWN_TIMEOUT_SECONDS` | Body-Limit (1 MiB, passend zu Nginx) und Shutdown-Wartezeit |
| `RATE_LIMIT_*` | Login, Login pro Konto, Registrierung, Refresh, übrige API |
| `TOMBSTONE_RETENTION_DAYS`, `SYNC_OPERATION_RETENTION_DAYS`, `SECURITY_EVENT_RETENTION_DAYS`, `SESSION_RETENTION_DAYS`, `MAINTENANCE_INTERVAL_HOURS` | Aufbewahrung und Wartung |
| `CORS_ALLOWED_ORIGINS` | Leer = CORS aus (die App braucht keins); `*` in Produktion verboten |
| `LOG_LEVEL`, `LOG_FORMAT`, `API_DOCS_ENABLED`, `INTERNAL_STATUS_TOKEN` | Logging, Swagger UI, interner Status |

## API im Überblick

Basis `https://<domain>/api/v1`, JSON, `Authorization: Bearer <accessToken>`. Vollständig in
[api/openapi.yaml](api/openapi.yaml) (inkl. Betrieb hinter Nginx/HTTPS; Swagger UI unter `/api/docs`, wenn
`API_DOCS_ENABLED=true`). Ein Test stellt sicher, dass jede Route dokumentiert ist und umgekehrt.

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
Sicherheit: [docs/SECURITY.md](docs/SECURITY.md) · Betrieb, Logs, Monitoring: [docs/OPERATIONS.md](docs/OPERATIONS.md)

## Entwicklung und Tests

Voraussetzung: Node.js 24 LTS (enthält npm).

```bash
npm ci                         # Abhängigkeiten exakt nach package-lock.json
npm run typecheck              # TypeScript-Prüfung (tsc --noEmit)
cp .env.example .env           # APP_ENV=development, DB_*, JWT_SECRET setzen
docker compose -f docker-compose.db-only.yml up -d    # oder eine lokale PostgreSQL
node src/cli.ts --env-file .env serve
```

Tests:

```bash
make test-db                   # Wegwerf-PostgreSQL in Docker (127.0.0.1:55432)
make test                      # Unit-, Integrations- und Nginx-Tests (Nginx-Tests, wenn nginx installiert ist)
make test-perf                 # Leistungstest mit 300 000 Berichten
```

bzw. direkt `BERICHTLY_TEST_DATABASE_URL=postgres://…/berichtly_test NGINX_BIN=nginx npm test`. Ohne
`BERICHTLY_TEST_DATABASE_URL` laufen nur die Unit-Tests, ohne `NGINX_BIN` werden die Nginx-Tests übersprungen.

Abgedeckt sind u. a.: Registrierung, Login, Token-Erneuerung und -Wiederverwendung, Logout, "überall abmelden",
Passwortänderung, Sitzungen, Geräteverwaltung, Benutzerisolierung (inkl. manipulierter IDs und `userId` im Body),
Profil, Berichte (Erstellen, Bearbeiten, Löschen, Pagination, Filter), Datumslogik (Sommer-/Winterzeit,
Jahreswechsel, ISO-Wochen), Synchronisationsszenarien (neues Gerät, bestehendes Berichtsheft, mehrere Geräte,
Löschung, Wiederholung, Netzwerkabbruch, echter Konflikt, gleichzeitige Übertragung, abgelaufener Cursor,
Wiederherstellung), Wartung, Migrationen (Upgrade 1.0 → 1.1 → 1.2 mit Bestandsdaten, Passwort-Hashes, Refresh
Tokens und Sync-Operationen aus 1.1), kontrollierter Shutdown, Rate Limiting und der vollständige Weg
**PostgreSQL → Node.js → Nginx** über HTTP und HTTPS (alle Methoden, Authorization-Header, X-Forwarded-For/-Proto,
413/404-Fehlerformat, HTTP→HTTPS-Umleitung, nur TLS 1.2/1.3).

Release-Archiv: `make release` (bzw. `./scripts/build-release.sh`) → `dist/berichtly-server-<version>.tar.gz`
inklusive Laufzeitabhängigkeiten; Container-Image: `make docker`.

## Roadmap (nach 1.2)

- API-Client und optionale Synchronisierung in Berichtly 2.2 (Android)
- Konto löschen und Datenexport über die API, Passwort-Reset per E-Mail
- Berichtsversionen (Verlauf wie `report_versions` in der App)
- Metriken-Endpunkt (z. B. Prometheus), Admin-Befehle zur Kontoverwaltung
- Optionale Erweiterungen: Push-Benachrichtigungen, serverseitige PDF-Erzeugung
