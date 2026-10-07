# Installation und Betrieb unter Linux – Berichtly Server 1.2

Zielumgebung: Debian 12 / Ubuntu 24.04 oder vergleichbar, x86_64 oder arm64, mit systemd, ohne grafische
Oberfläche. Alles wird über die Kommandozeile erledigt.

## Produktionsarchitektur

```
Internet ──HTTPS:443 / HTTP:80──▶ Nginx  (einziger öffentlicher Dienst)
                                    │  TLS 1.2/1.3, HSTS, HTTP→HTTPS, Body-Limit, Grund-Rate-Limit
                                    │  /api/*      → http://127.0.0.1:3000 (Keep-Alive)
                                    │  /internal/*, alles andere → 404
                                    ▼
                          Node.js 24 LTS – Berichtly Server (127.0.0.1:3000, Benutzer "berichtly", systemd)
                                    │  Connection-Pool (≤ 10 Verbindungen)
                                    ▼
                          PostgreSQL (nur localhost, niemals öffentlich)
```

- Öffentlich sind nur die Ports 80 und 443. Firewall z. B.:
  `sudo ufw allow OpenSSH && sudo ufw allow 80,443/tcp && sudo ufw enable` – Port 3000 und 5432 bleiben zu.
- Node.js lauscht nur auf `127.0.0.1` (`SERVER_HOST`), PostgreSQL nur auf `localhost` (Standard bei Debian/Ubuntu).
- `TRUST_PROXY=true`: Node.js übernimmt Client-IP und Protokoll von Nginx (genau ein vertrauenswürdiger Proxy).

## Variante A: Linux direkt (systemd + Nginx)

### 1. Pakete

Node.js 24 LTS ist in den Paketquellen von Debian 12/Ubuntu 24.04 nicht enthalten. Bezugsquellen: die offiziellen
Linux-Binärpakete von nodejs.org (nach `/usr/local/lib/nodejs` entpacken und `/usr/bin/node` verlinken) oder das
NodeSource-Repository. Die systemd-Unit erwartet `/usr/bin/node`.

```bash
sudo apt update
sudo apt install -y postgresql nginx certbot gettext-base
node --version        # v24.x
```

### 2. Datenbank

```bash
DBPW=$(openssl rand -base64 32); echo "DB-Passwort: $DBPW"
sudo -u postgres psql -v pw="$DBPW" <<'SQL'
CREATE ROLE berichtly LOGIN PASSWORD :'pw';
CREATE DATABASE berichtly OWNER berichtly ENCODING 'UTF8';
SQL
```

### 3. Node.js-Server installieren

Release-Archiv auf den Server kopieren, Prüfsumme kontrollieren und installieren:

```bash
sha256sum -c SHA256SUMS
tar xzf berichtly-server-1.2.0.tar.gz
cd berichtly-server-1.2.0
sudo ./deploy/install.sh
```

`install.sh` prüft die Node.js-Version, legt den Systembenutzer `berichtly` (ohne Shell, ohne Home) an,
installiert das Programm nach `/opt/berichtly-server/` (gehört root, für den Dienst nur lesbar), verlinkt
`/usr/local/bin/berichtly-server`, legt `/etc/berichtly-server/berichtly-server.env` an (Rechte
`0640 root:berichtly`, wird nie überschrieben) und installiert die systemd-Unit. Das Release-Archiv enthält die
Laufzeitabhängigkeiten bereits; auf dem Server wird kein npm und kein Internetzugang benötigt.

### 4. Konfigurieren

```bash
sudo nano /etc/berichtly-server/berichtly-server.env
```

Mindestens `DB_PASSWORD` und `JWT_SECRET` (`openssl rand -base64 48`) setzen. `APP_ENV=production`,
`SERVER_HOST=127.0.0.1`, `SERVER_PORT=3000` und `TRUST_PROXY=true` sind voreingestellt. Optional
`INTERNAL_STATUS_TOKEN` (`openssl rand -hex 32`) und `REGISTRATION_ENABLED`.

```bash
CONF=/etc/berichtly-server/berichtly-server.env
sudo -u berichtly berichtly-server --env-file $CONF check-config
sudo -u berichtly berichtly-server --env-file $CONF db-check        # Verbindung + Schema
sudo -u berichtly berichtly-server --env-file $CONF migrate
sudo -u berichtly berichtly-server --env-file $CONF migrate-status
```

### 5. Starten, prüfen, stoppen

```bash
sudo systemctl enable --now berichtly-server        # "enable" = automatischer Start nach jedem Neustart
systemctl status berichtly-server
journalctl -u berichtly-server -f                     # JSON-Logs
sudo -u berichtly berichtly-server --env-file $CONF healthcheck
sudo systemctl restart berichtly-server
sudo systemctl stop berichtly-server                  # kontrollierter Shutdown
```

Beim Stoppen und beim Neustart des Linux-Servers sendet systemd SIGTERM: Der Server beantwortet neue Anfragen mit
`503 SERVICE_UNAVAILABLE`, beendet laufende Requests (höchstens `SHUTDOWN_TIMEOUT_SECONDS`, Standard 15 s),
schließt Keep-Alive-Verbindungen und den Datenbank-Pool. `TimeoutStopSec=30` gibt ihm dafür genug Zeit.

### 6. Nginx und HTTPS

```bash
sudo ./deploy/install-nginx.sh berichtly.example.de http
sudo certbot certonly --webroot -w /var/www/certbot -d berichtly.example.de --deploy-hook "systemctl reload nginx"
sudo ./deploy/install-nginx.sh berichtly.example.de https
```

Details, Erneuerung und Prüfung: [HTTPS.md](HTTPS.md).

### Dienste im Überblick

| Dienst | Befehle | Logs |
|---|---|---|
| `berichtly-server` | `sudo systemctl status/start/stop/restart berichtly-server`, `enable`/`disable` für den Autostart | `journalctl -u berichtly-server` |
| `nginx` | `sudo nginx -t` (Konfiguration prüfen), `sudo systemctl reload nginx` (ohne Unterbrechung), `restart`, `status` | `/var/log/nginx/access.log` (JSON), `/var/log/nginx/error.log`, `journalctl -u nginx` |
| `postgresql` | `sudo systemctl status/restart postgresql` | `journalctl -u postgresql`, `/var/log/postgresql/` |
| Zertifikate | `systemctl list-timers certbot.timer`, `sudo certbot renew --dry-run` | `journalctl -u certbot` |

Startreihenfolge: Die Unit von Berichtly Server startet nach `postgresql.service`. Ist die Datenbank noch nicht
bereit, startet systemd den Dienst automatisch neu (`Restart=on-failure`). Nginx beantwortet Anfragen in dieser Zeit
mit `503 SERVICE_UNAVAILABLE` im API-Format.

### Update

Neues Release-Archiv entpacken und `sudo ./deploy/install.sh` ausführen. Läuft der Dienst bereits, führt das
Skript die Migrationen aus und startet ihn neu; die Konfiguration bleibt unverändert. Vorher ein Backup erstellen
([BACKUP.md](BACKUP.md)). Nginx-Snippets aktualisieren: `sudo ./deploy/install-nginx.sh <domain> https`.
Upgrade von 1.1 (Go) auf 1.2 (Node.js): [UPGRADE.md](UPGRADE.md).

## Variante B: Docker Compose

Drei Dienste: `nginx` (öffentlich, 80/443), `server` (Node.js, intern) und `db` (PostgreSQL 17, intern).

```bash
cp .env.example .env               # DB_PASSWORD, JWT_SECRET, BERICHTLY_DOMAIN setzen
# Zertifikat beziehen: siehe HTTPS.md, Abschnitt "Docker Compose"
docker compose up -d --build
docker compose ps                  # alle drei "healthy"
docker compose logs -f nginx server
```

- Nur Nginx veröffentlicht Ports. `server` und `db` hängen ausschließlich im internen Netz `backend`
  (`internal: true`: nicht vom Host erreichbar, kein Internetzugang); Nginx ist zusätzlich im Netz `edge`.
- Startreihenfolge über Healthchecks: `db` (echtes `pg_isready`) → `server` (`/api/v1/health/ready`: Datenbank
  erreichbar und Schema aktuell) → `nginx`.
- Der Server-Container läuft als Benutzer `node` (nicht root), mit schreibgeschütztem Dateisystem, ohne
  Linux-Capabilities und mit `no-new-privileges`.
- Daten liegen im Volume `berichtly_db-data` und überstehen Neustarts, `docker compose down` und Updates. Nur
  `docker compose down -v` löscht sie.
- PostgreSQL bleibt auf Hauptversion 17 (wie in 1.1); ein Wechsel der Hauptversion erfordert Dump und Restore.
- Logs: Docker `json-file` mit Rotation (10 MB × 5 pro Container).

Entwicklung: `docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build` startet Nginx ohne TLS auf
`127.0.0.1:8080`, den Server im Entwicklungsmodus und macht PostgreSQL auf `127.0.0.1:5432` erreichbar. Ohne die
Dev-Datei gilt immer die Produktionskonfiguration.

Befehle in Containern: `docker compose exec server node src/cli.ts migrate-status` bzw. `… db-check`,
`… maintenance`.

## Wartung

Der Server entfernt einmal täglich (`MAINTENANCE_INTERVAL_HOURS`) Daten, deren Aufbewahrungsfrist abgelaufen ist:
alte Tombstones (365 Tage), Idempotenz-Einträge (30 Tage), Sicherheitsereignisse (180 Tage) und abgelaufene oder
widerrufene Sitzungen (30 Tage). Bei mehreren Instanzen läuft die Wartung dank Datenbanksperre nur einmal.
Alternativ `MAINTENANCE_INTERVAL_HOURS=0` und per Timer/Cron `berichtly-server maintenance`.

## Backups, Logs und Monitoring

- Backups: [BACKUP.md](BACKUP.md) (pg_dump, Ablage außerhalb des Servers, Wiederherstellung mit `reset-sync-cursors`).
- Logs, Log-Rotation, Health-Checks und interner Status: [OPERATIONS.md](OPERATIONS.md).
