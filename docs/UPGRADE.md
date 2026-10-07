# Upgrade-Anleitung – Berichtly Server

- [1.1 → 1.2 (Go → Node.js, Nginx)](#upgrade-von-11-auf-12)
- [1.0 Alpha → 1.1](#upgrade-von-10-alpha-auf-11)

Vor jedem Upgrade ein Backup erstellen ([BACKUP.md](BACKUP.md)).

## Upgrade von 1.1 auf 1.2

Berichtly Server 1.2 ersetzt die Go-Implementierung durch **Node.js 24 LTS** und stellt **Nginx** als einzigen
öffentlichen Zugang davor. API, Datenbank und Verhalten bleiben gleich:

- **Gleiche API**: alle 39 Endpunkte unter `/api/v1` mit identischen Feldern, Statuscodes und Fehlercodes. Einzige
  Ergänzung: der Fehlercode `SERVICE_UNAVAILABLE` (503), wenn der Server kurzzeitig nicht erreichbar ist.
- **Gleiche Datenbank**: Die Migrationen 0001 und 0002 sind byteidentisch übernommen. Neu ist nur
  `0003_server_1_2.sql` – **rein additiv** (eine Spalte mit Standardwert, ein Index); keine Zeile wird verändert.
- **Angemeldete Apps bleiben angemeldet**: Passwort-Hashes (Argon2id), Access Tokens (JWT, gleiches `JWT_SECRET`)
  und Refresh Tokens aus 1.1 funktionieren unverändert.
- **Sync-Wiederholungen bleiben sicher**: Von 1.1 verarbeitete Operationen (`operationId`) werden weiterhin
  erkannt. 1.1 hat die Prüfsumme aus den Rohbytes der Anfrage berechnet, 1.2 aus dem geprüften JSON; für Einträge
  aus 1.1 (`hash_format = 1`) vergleicht 1.2 deshalb Typ und Datensatz-ID statt der Prüfsumme.
- **Gleiche Konfiguration**: Alle Variablen aus 1.1 gelten weiter. Neu ist der Standardport `3000` (vorher `8080`);
  eine vorhandene Konfiguration mit `SERVER_PORT=8080` funktioniert weiter – `install-nginx.sh` liest den Port aus
  der Konfiguration.

Der Upgrade-Weg ist automatisiert getestet (`test/integration/upgrade.test.ts`): Schema 1.0 mit Bestandsdaten →
1.1 mit Sitzung, Refresh Token, Sync-Operation und Passwort-Hash aus dem Go-Server → 1.2; Prüfsumme aller
Bestandsdaten, danach Refresh, Login, Abfragen, Wiederholung der alten Operation und Bearbeitung über die API.

### Ablauf (Linux, systemd)

```bash
# 1. Backup
sudo -u postgres pg_dump -Fc berichtly > berichtly-vor-1.2-$(date +%F).dump

# 2. Node.js 24 LTS installieren (siehe DEPLOYMENT.md) und prüfen
node --version

# 3. Release-Archiv 1.2 installieren: ersetzt die Go-Binärdatei, migriert, startet den Dienst neu
tar xzf berichtly-server-1.2.0.tar.gz && cd berichtly-server-1.2.0
sudo ./deploy/install.sh

# 4. Konfiguration prüfen: TRUST_PROXY=true (Server nur hinter Nginx), SERVER_HOST=127.0.0.1
sudo grep -E '^(SERVER_HOST|SERVER_PORT|TRUST_PROXY)=' /etc/berichtly-server/berichtly-server.env
sudo -u berichtly berichtly-server --env-file /etc/berichtly-server/berichtly-server.env migrate-status

# 5. Nginx auf die 1.2-Konfiguration umstellen (deaktiviert die alte Seite aus 1.1; Zertifikat bleibt)
sudo apt install -y gettext-base
sudo ./deploy/install-nginx.sh berichtly.example.de https
curl -s https://berichtly.example.de/api/v1/health/ready
```

Wurde in 1.1 Caddy statt Nginx verwendet: Caddy stoppen und deaktivieren (`sudo systemctl disable --now caddy`),
dann Nginx nach [HTTPS.md](HTTPS.md) einrichten (neues Zertifikat über Certbot).

### Ablauf (Docker Compose)

In 1.1 war der Server-Container auf `127.0.0.1:8080` veröffentlicht und ein Reverse Proxy auf dem Host leitete
dorthin weiter. In 1.2 übernimmt der Nginx-Container die Ports 80/443; ein Reverse Proxy auf dem Host muss deshalb
vorher gestoppt werden. Das Datenbank-Volume `berichtly_db-data` wird unverändert weiterverwendet.

```bash
docker compose exec -T db pg_dump -U berichtly -Fc berichtly > berichtly-vor-1.2-$(date +%F).dump
git pull                                   # bzw. neuen Projektstand einspielen
# .env ergänzen: BERICHTLY_DOMAIN (siehe .env.example); SERVER_PUBLISHED_PORT wird nicht mehr verwendet
sudo systemctl disable --now nginx          # nur falls Nginx/Caddy auf dem Host lief
docker compose up -d --build --remove-orphans
docker compose ps
```

Zertifikate liegen weiterhin auf dem Host unter `/etc/letsencrypt`; der Nginx-Container bindet sie nur lesend ein.
Für die Erneuerung den Deploy-Hook auf den Container umstellen ([HTTPS.md](HTTPS.md), Abschnitt Docker):
`sudo certbot reconfigure --cert-name <domain> --deploy-hook "docker compose --project-directory <pfad> exec -T nginx nginx -s reload"`
(ältere Certbot-Versionen: `deploy_hook` in `/etc/letsencrypt/renewal/<domain>.conf` anpassen).

### Rückweg

Ein Zurück auf 1.1 ist mit dem 1.2-Schema technisch möglich (1.1 ignoriert die neue Spalte und warnt nur, dass das
Schema neuer ist), wird aber nicht getestet. Von 1.2 gespeicherte Sync-Operationen würde 1.1 bei einer Wiederholung
als `OPERATION_ID_REUSED` ablehnen, solange sie nicht abgelaufen sind (30 Tage). Sicherer Weg: das vor dem Upgrade
erstellte Backup wiederherstellen.

### Neue Konfigurationsoptionen in 1.2

| Variable | Standard | Bedeutung |
|---|---|---|
| `SERVER_PORT` | 3000 (vorher 8080) | Interner Port von Node.js (nur 127.0.0.1) |
| `BERICHTLY_DOMAIN` | – | Domain für die Nginx-Vorlage |
| `NGINX_CONFIG`, `NGINX_HTTP_PORT`, `NGINX_HTTPS_PORT`, `LETSENCRYPT_DIR`, `CERTBOT_WEBROOT`, `DB_DEV_PORT` | siehe `.env.example` | nur Docker Compose |

## Upgrade von 1.0 Alpha auf 1.1

Berichtly Server 1.1 ist eine kompatible Weiterentwicklung von 1.0 Alpha. Alle Benutzer, Profile, Geräte,
Sitzungen und Berichte bleiben erhalten; angemeldete Apps müssen sich nicht neu anmelden.

### Was beim Upgrade passiert

- Die Migration `0002_server_1_1.sql` wird angewendet. Sie ist **rein additiv**: neue Spalten (mit
  Standardwerten bzw. `NULL`), neue Tabellen (`sync_operations`, `security_events`, `server_state`) und neue
  Indizes. Es wird keine Zeile gelöscht oder verändert.
- Bestehende Geräte erhalten den Synchronisationsstatus `NEVER`, bis sie zum ersten Mal einen Abschluss melden.
  Die bisherigen Werte `lastPullAt`/`lastPullCursor`/`lastPushAt` bleiben erhalten.
- Bestehende Berichte haben keine Herkunftsangaben (`clientUpdatedAt`, `clientLocalId` … = `null`).
- Der Upgrade-Weg ist automatisiert getestet (`TestUpgradeVon10AlphaAuf11OhneDatenverlust`): 1.0-Schema mit
  realistischen Daten anlegen, migrieren, Prüfsumme aller Bestandsdaten vergleichen, danach Login, Abfragen,
  Synchronisierung und Bearbeitung über die API.

### Ablauf (systemd)

```bash
# 1. Backup (siehe docs/BACKUP.md)
sudo -u postgres pg_dump -Fc berichtly > berichtly-vor-1.1-$(date +%F).dump

# 2. Release-Archiv 1.1 entpacken und installieren (Konfiguration bleibt unverändert)
tar xzf berichtly-server-1.1.0-linux-amd64.tar.gz
cd berichtly-server-1.1.0-linux-amd64
sudo ./deploy/install.sh        # führt bei laufendem Dienst Migrationen aus und startet neu

# 3. Prüfen
CONF=/etc/berichtly-server/berichtly-server.env
sudo -u berichtly /opt/berichtly-server/berichtly-server --env-file $CONF migrate-status
sudo -u berichtly /opt/berichtly-server/berichtly-server --env-file $CONF db-check
curl -s http://127.0.0.1:8080/api/v1/health/ready
```

Die neue systemd-Unit wird von `install.sh` ebenfalls installiert. Neue Konfigurationsoptionen (siehe unten)
haben sichere Standardwerte und müssen nicht gesetzt werden.

### Ablauf (Docker Compose)

```bash
docker compose exec -T db pg_dump -U berichtly -Fc berichtly > berichtly-vor-1.1-$(date +%F).dump
git pull                        # bzw. neuen Projektstand einspielen
docker compose up -d --build    # Server migriert beim Start (DB_MIGRATE_ON_START=true)
docker compose ps
```

### Sicherheitsnetz beim Start

1.1 startet nicht, wenn das Datenbankschema älter ist als erwartet und `DB_MIGRATE_ON_START=false` gesetzt ist –
statt mit einem unvollständigen Schema Fehler zu produzieren. Migrationen, die nach dem Anwenden verändert wurden,
werden per Prüfsumme erkannt und blockieren den Start (`migrate-status` zeigt `modified`).

### Rückweg

Ein Downgrade auf 1.0 ist mit dem 1.1-Schema technisch möglich (1.0 ignoriert die neuen Spalten und Tabellen),
wird aber nicht getestet und nicht empfohlen. Sicherer Weg: das vor dem Upgrade erstellte Backup
wiederherstellen (docs/BACKUP.md).

### Änderungen an der API (alle rückwärtskompatibel)

Bestehende Endpunkte, Felder und Fehlercodes aus 1.0 sind unverändert. Neu:

| Bereich | Neu in 1.1 |
|---|---|
| System | `GET /health/ready` (Readiness: Datenbank + Schema) |
| Auth/Konto | `POST /auth/logout-all`, `POST /account/password`, `GET /account/security-events`, `GET /sessions`, `DELETE /sessions/{id}` |
| Geräte | `POST /devices`, `GET /devices/{id}`, `PATCH /devices/{id}`; `GET /devices` ist paginiert (`meta`) und kennt `includeRevoked`; `DELETE /devices/{id}` markiert das Gerät zusätzlich als abgemeldet |
| Berichte | Optionale Felder `clientUpdatedAt`, `clientLocalId` in Anfragen; Antworten zusätzlich mit `clientUpdatedAt`, `clientLocalId`, `createdByDeviceId`, `lastModifiedByDeviceId`, `lastOperationId`; Listenfilter `year`, `month`, `isoYear`, `isoWeek` |
| Wochen | `GET /weeks/{isoYear}/{isoWeek}`; Wochenübersicht zusätzlich mit `today` |
| Sync | `POST /sync` (Push + Pull in einem Schritt), `POST /sync/complete`; Push-Elemente mit optionaler `operationId`; Ergebnisse mit `operationId`, `replayed`; `GET /sync/status` zusätzlich mit `minValidCursor` und Gerätestatus (`syncStatus`, `lastSyncAt` …) |
| Fehlercodes | `SYNC_CURSOR_EXPIRED` (410), `DEVICE_REQUIRED` (409), `OPERATION_ID_REUSED` (im Push-Ergebnis) |

Hinweis zu `GET /devices`: Abgemeldete Geräte erscheinen standardmäßig nicht mehr in der Liste (in 1.0 gab es
noch kein Abmelden auf Geräteebene, nur das Widerrufen der Sitzungen).

### Neue Konfigurationsoptionen

| Variable | Standard | Bedeutung |
|---|---|---|
| `RATE_LIMIT_LOGIN_PER_MINUTE` | 10 | Login pro IP |
| `RATE_LIMIT_LOGIN_PER_ACCOUNT_PER_MINUTE` | 5 | Login pro Konto (E-Mail) |
| `RATE_LIMIT_REGISTER_PER_MINUTE` | 5 | Registrierung pro IP |
| `RATE_LIMIT_REFRESH_PER_MINUTE` | 30 | Token-Erneuerung pro IP |
| `TOMBSTONE_RETENTION_DAYS` | 365 | Aufbewahrung gelöschter Berichte für die Synchronisierung |
| `SYNC_OPERATION_RETENTION_DAYS` | 30 | Aufbewahrung der Idempotenz-Einträge |
| `SECURITY_EVENT_RETENTION_DAYS` | 180 | Aufbewahrung der Sicherheitsereignisse |
| `SESSION_RETENTION_DAYS` | 30 | Löschen abgelaufener/widerrufener Sitzungen |
| `MAINTENANCE_INTERVAL_HOURS` | 24 | Automatische Wartung (0 = aus) |

`RATE_LIMIT_AUTH_PER_MINUTE` aus 1.0 wird weiterhin berücksichtigt: Ist die Variable gesetzt, gilt ihr Wert als
Standard für Login, Registrierung und Token-Erneuerung – das Verhalten einer bestehenden Installation ändert sich
also nicht, bis die neuen Variablen gesetzt werden.
