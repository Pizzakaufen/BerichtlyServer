# Installation und Betrieb unter Linux

Zielumgebung: Debian 12 / Ubuntu 24.04 oder vergleichbar, x86_64 oder arm64, mit systemd, ohne grafische
Oberfläche. Alles wird über die Kommandozeile erledigt. Der Server ist eine einzige statische Binärdatei –
auf dem Server werden weder Go noch Java oder andere Laufzeitumgebungen benötigt.

## Produktionsarchitektur

```
Internet ──HTTPS:443──▶ Reverse Proxy (Nginx / Caddy / Traefik)
                           │  TLS, HSTS, Body-Limit
                           │  /api/*      → http://127.0.0.1:8080
                           │  /internal/* → 404
                           ▼
                    Berichtly Server (127.0.0.1:8080, Benutzer "berichtly", systemd oder Docker)
                           │  Connection-Pool (≤ 10 Verbindungen)
                           ▼
                    PostgreSQL (nur localhost bzw. privates Docker-Netz, niemals öffentlich)
```

- Öffentlich sind nur Port 443 (und 80 für Zertifikate/Weiterleitung). Firewall z. B.:
  `sudo ufw allow OpenSSH && sudo ufw allow 80,443/tcp && sudo ufw enable`
- PostgreSQL lauscht nur auf `localhost` (Standard bei Debian/Ubuntu) bzw. hat in Docker keine veröffentlichten Ports.
- Der Server setzt `TRUST_PROXY=true`, damit das Rate Limiting die echte Client-IP aus `X-Forwarded-For` verwendet.

## Variante A: systemd (empfohlen)

### 1. Pakete

```bash
sudo apt update
sudo apt install -y postgresql nginx certbot python3-certbot-nginx
```

### 2. Datenbank

```bash
DBPW=$(openssl rand -base64 32); echo "DB-Passwort: $DBPW"
sudo -u postgres psql -v pw="$DBPW" <<'SQL'
CREATE ROLE berichtly LOGIN PASSWORD :'pw';
CREATE DATABASE berichtly OWNER berichtly ENCODING 'UTF8';
SQL
```

### 3. Installieren

Release-Archiv passend zur Architektur (`uname -m`: `x86_64` → amd64, `aarch64` → arm64) auf den Server kopieren,
Prüfsumme kontrollieren und installieren:

```bash
sha256sum -c SHA256SUMS --ignore-missing
tar xzf berichtly-server-1.0.0-alpha-linux-amd64.tar.gz
cd berichtly-server-1.0.0-alpha-linux-amd64
sudo ./deploy/install.sh
```

`install.sh` legt den Systembenutzer `berichtly` (ohne Shell, ohne Home) an, installiert die Binärdatei nach
`/opt/berichtly-server/` (gehört root, für den Dienst nur ausführbar), legt
`/etc/berichtly-server/berichtly-server.env` an (Rechte `0640 root:berichtly`, wird nie überschrieben) und
installiert die systemd-Unit.

### 4. Konfigurieren

```bash
sudo nano /etc/berichtly-server/berichtly-server.env
```

Mindestens `DB_PASSWORD`, `JWT_SECRET` (`openssl rand -base64 48`) und `TRUST_PROXY=true` setzen.
Optional `INTERNAL_STATUS_TOKEN` (`openssl rand -hex 32`) und `REGISTRATION_ENABLED`.

```bash
CONF=/etc/berichtly-server/berichtly-server.env
sudo -u berichtly /opt/berichtly-server/berichtly-server --env-file $CONF check-config
sudo -u berichtly /opt/berichtly-server/berichtly-server --env-file $CONF migrate
```

### 5. Starten, prüfen, stoppen

```bash
sudo systemctl enable --now berichtly-server
systemctl status berichtly-server
journalctl -u berichtly-server -f                     # JSON-Logs
sudo -u berichtly /opt/berichtly-server/berichtly-server --env-file $CONF healthcheck
sudo systemctl stop berichtly-server                  # kontrollierter Shutdown
```

systemd sendet beim Stoppen und beim Neustart des Linux-Servers SIGTERM: Der Server nimmt keine neuen Verbindungen
mehr an, beendet laufende Requests (höchstens `SHUTDOWN_TIMEOUT_SECONDS`) und schließt den Datenbank-Pool.

### 6. HTTPS mit Nginx

```bash
sudo cp deploy/nginx/berichtly.conf /etc/nginx/sites-available/berichtly
sudo sed -i 's/berichtly.example.de/IHRE-DOMAIN/g' /etc/nginx/sites-available/berichtly
sudo certbot certonly --nginx -d IHRE-DOMAIN
sudo ln -s /etc/nginx/sites-available/berichtly /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

Alternativ Caddy mit automatischem HTTPS: `deploy/caddy/Caddyfile`.

### Update

Neues Release-Archiv entpacken und `sudo ./deploy/install.sh` ausführen. Läuft der Dienst bereits, führt das
Skript die Migrationen aus und startet ihn neu.

## Variante B: Docker Compose

```bash
cp .env.example .env
# setzen: APP_ENV=production, DB_PASSWORD, JWT_SECRET, TRUST_PROXY=true, LOG_FORMAT=json, API_DOCS_ENABLED=false
docker compose up -d --build
docker compose ps
```

- Der Server ist nur unter `127.0.0.1:8080` veröffentlicht; Nginx/Caddy auf dem Host leitet dorthin weiter.
- PostgreSQL hängt nur im internen Netz `backend` (ohne Internetzugang, ohne veröffentlichte Ports).
- Der Server-Container läuft als `nonroot`, mit schreibgeschütztem Dateisystem und ohne Linux-Capabilities.
- Daten liegen im Volume `berichtly_db-data`.

## Backups (manuell, 1.0 Alpha)

```bash
sudo -u postgres pg_dump -Fc berichtly > berichtly-$(date +%F).dump                      # systemd
docker compose exec -T db pg_dump -U berichtly -Fc berichtly > berichtly-$(date +%F).dump # Docker
pg_restore -d berichtly --clean berichtly-JJJJ-MM-TT.dump                                # Wiederherstellen
```

Backups enthalten personenbezogene Daten – verschlüsselt und getrennt vom Server aufbewahren.

## Monitoring

- `GET /api/v1/health` → `200` (gesund) bzw. `503` (Datenbank nicht erreichbar) – für Uptime-Monitore.
- `GET /internal/status` mit `Authorization: Bearer $INTERNAL_STATUS_TOKEN` → Datenbanklatenz, Schema-Version,
  Pool-Auslastung, Speicher, freier Plattenplatz, Request- und Fehlerzähler. Nur intern abfragen:
  `curl -H "Authorization: Bearer …" http://127.0.0.1:8080/internal/status`
