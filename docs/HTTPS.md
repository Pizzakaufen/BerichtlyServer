# HTTPS mit Nginx – mit Domain (Let's Encrypt) oder ohne Domain (IP-Adresse) – Berichtly Server 1.2.1

Nginx ist der **einzige öffentlich erreichbare Dienst**. Er beendet TLS, leitet HTTP auf HTTPS um und reicht nur
`/api/` an den Node.js-Server weiter, der selbst nur intern lauscht (`127.0.0.1:3000` bzw. im Docker-Netz).

Dateien:

| Datei | Zweck |
|---|---|
| `deploy/nginx/templates/berichtly-https.conf.template` | **Produktion**: Port 80 (nur ACME + Umleitung) und 443 (TLS 1.2/1.3, HSTS) |
| `deploy/nginx/templates/berichtly-ip.conf.template` | **Ohne Domain**: HTTPS über die IP-Adresse mit eigenem Zertifikat (siehe unten) |
| `deploy/nginx/templates/berichtly-http.conf.template` | **Nur Entwicklung und Ersteinrichtung** (kein TLS) |
| `deploy/nginx/snippets/berichtly-http-context.conf` | Request-ID, HSTS-Zuordnung, Rate-Limit-Zonen, JSON-Zugriffslog |
| `deploy/nginx/snippets/berichtly-api.conf` | Locations: `/api/`, strengeres Limit für Auth, `/internal/` → 404, Fehlerseiten im API-Format |
| `deploy/nginx/snippets/berichtly-proxy.conf` | Weiterleitung an Node.js: Header, Keep-Alive, Timeouts |
| `deploy/install-nginx.sh` | Linux: Vorlage mit Domain rendern, `nginx -t`, aktivieren, neu laden |

Die Domain steht in keiner Datei fest: Die Vorlagen enthalten `${BERICHTLY_DOMAIN}` und `${BERICHTLY_UPSTREAM}`,
die beim Einrichten ersetzt werden (Linux: `install-nginx.sh`, Docker: das offizielle nginx-Image).

## Was die Konfiguration leistet

- **TLS 1.2 und 1.3**, Cipher Suites nach Mozilla "intermediate", keine Session-Tickets. OCSP-Stapling entfällt,
  weil Let's Encrypt seit 2025 keine OCSP-Responder mehr betreibt.
- **HTTP → HTTPS** mit `308` (Methode und Body bleiben erhalten). Ausnahme: `/.well-known/acme-challenge/` für
  Let's Encrypt. Die App muss trotzdem immer `https://` verwenden – eine Umleitung kann ein über HTTP gesendetes
  Token nicht mehr schützen.
- **HSTS** `max-age=31536000` nur über HTTPS, genau einmal (eine zusätzliche Angabe von Node.js wird entfernt).
  Bewusst ohne `includeSubDomains`/`preload`, damit andere Subdomains nicht ungewollt betroffen sind.
- **Weiterleitung**: Methode, Pfad, Query, Body, Statuscode und alle Header (auch `Authorization`) unverändert;
  zusätzlich `X-Forwarded-For`, `X-Forwarded-Proto`, `X-Forwarded-Host`, `X-Forwarded-Port`, `X-Real-IP` und
  `X-Request-ID`. Node.js vertraut genau einem Proxy (`TRUST_PROXY=true`): Die Client-IP ist der letzte Eintrag von
  `X-Forwarded-For` (den Nginx anhängt) – gefälschte Einträge des Clients davor zählen nicht.
- **Keep-Alive** zum Upstream (32 Verbindungen, 60 s; Node.js hält 75 s, damit Nginx Verbindungen zuerst schließt),
  Timeouts: Verbindungsaufbau 5 s, Senden/Lesen 60 s, Client-Header 15 s, Client-Body 30 s. POST/PATCH werden nie
  automatisch wiederholt.
- **Größenlimit** `client_max_body_size 1m` (wie `MAX_REQUEST_BODY_BYTES`); Node.js prüft zusätzlich selbst.
- **Rate Limiting (Grundschutz)**: 20 Anfragen/s pro IP mit Burst 100 für `/api/`, 60/min mit Burst 20 für
  `/api/v1/auth/` und die Passwortänderung, max. 50 gleichzeitige Verbindungen pro IP. Die feinen Grenzen
  (Login pro IP und pro Konto, Registrierung, Refresh) setzt Node.js.
- **Fehler von Nginx** (413, 429, 502/503/504, unbekannte Pfade) kommen im Fehlerformat der API
  (`{"error":{"code":…,"requestId":…}}`); Antworten von Node.js werden unverändert durchgereicht.
- **Logs**: Zugriffslog als JSON ohne Query-Strings, Header oder Bodies (also nie Tokens), mit derselben
  `request_id`, die auch Node.js loggt. `server_tokens off` (keine Versionsnummer).
- `/internal/` ist von außen nie erreichbar; außerhalb von `/api/` gibt es keine Inhalte.

Getestet mit Nginx 1.30 über `test/nginx/nginx.test.ts` (HTTP und HTTPS mit zur Laufzeit erzeugtem,
selbst signiertem Testzertifikat): alle Methoden, Authorization-Header, X-Forwarded-For/-Proto, 413/404/429,
Umleitung, TLS-Versionen.

## Linux (systemd): Einrichtung

Voraussetzungen: DNS-Eintrag (A/AAAA) der Domain zeigt auf den Server, Ports 80 und 443 sind offen, der
Node.js-Server läuft (`systemctl status berichtly-server`).

```bash
sudo apt install -y nginx certbot gettext-base
sudo ufw allow 80,443/tcp          # falls ufw verwendet wird; Port 3000 bleibt geschlossen
```

### 1. Ersteinrichtung (noch ohne Zertifikat)

```bash
sudo ./deploy/install-nginx.sh berichtly.example.de http
```

Dabei ist die API kurzzeitig nur über HTTP erreichbar – die App in dieser Phase **nicht** verwenden.

### 2. Zertifikat beziehen

```bash
sudo certbot certonly --webroot -w /var/www/certbot -d berichtly.example.de \
     --email admin@example.de --agree-tos --no-eff-email \
     --deploy-hook "systemctl reload nginx"
```

Certbot speichert Zertifikat und privaten Schlüssel unter `/etc/letsencrypt/live/berichtly.example.de/`
(nur root lesbar). Private Schlüssel und Zertifikate gehören **nie** ins Git-Repository.

### 3. HTTPS aktivieren

```bash
sudo ./deploy/install-nginx.sh berichtly.example.de https
curl -I https://berichtly.example.de/api/v1/health      # 200, Strict-Transport-Security
curl -I http://berichtly.example.de/api/v1/health       # 308 → https://
```

### Automatische Erneuerung

Das Certbot-Paket von Debian/Ubuntu installiert einen systemd-Timer, der Zertifikate zweimal täglich prüft und
30 Tage vor Ablauf erneuert. Der oben angegebene `--deploy-hook` wird in der Erneuerungskonfiguration gespeichert
und lädt Nginx nach jeder Erneuerung neu. Prüfen:

```bash
systemctl list-timers certbot.timer          # Timer aktiv?
sudo certbot renew --dry-run                  # Erneuerung testweise durchspielen
grep deploy_hook /etc/letsencrypt/renewal/berichtly.example.de.conf
```

Wurde Certbot nicht als Distributionspaket installiert (z. B. per snap oder pip), unbedingt prüfen, dass ein Timer
bzw. Cron-Job existiert. Ohne funktionierende Erneuerung läuft das Zertifikat nach 90 Tagen ab und die App kann
keine Verbindung mehr aufbauen. Ein externes Monitoring der Ablaufzeit ist empfehlenswert.

## Docker Compose: Einrichtung

Certbot läuft **auf dem Host**; der Nginx-Container bindet `/etc/letsencrypt` nur lesend ein und liefert die
ACME-Prüfdateien aus `./deploy/certbot/www` aus. Eine vollautomatische Erneuerung *innerhalb* von Docker ist bewusst
nicht eingebaut – sie wäre nur mit einem zusätzlichen Certbot-Container und einem Neuladen von Nginx über den
Docker-Socket möglich. Stattdessen wird der Certbot-Timer des Hosts verwendet:

```bash
sudo apt install -y certbot
cp .env.example .env               # BERICHTLY_DOMAIN, DB_PASSWORD, JWT_SECRET setzen

# 1. Ersteinrichtung: Nginx ohne TLS starten (nur für die Zertifikatsprüfung)
NGINX_CONFIG=http docker compose up -d --build

# 2. Zertifikat beziehen; der Deploy-Hook lädt künftig den Nginx-Container neu
sudo certbot certonly --webroot -w "$PWD/deploy/certbot/www" -d berichtly.example.de \
     --email admin@example.de --agree-tos --no-eff-email \
     --deploy-hook "docker compose --project-directory $PWD exec -T nginx nginx -s reload"

# 3. Produktionsbetrieb (NGINX_CONFIG=https ist der Standard)
docker compose up -d
docker compose ps
```

Die Erneuerung übernimmt danach `certbot.timer` auf dem Host (`sudo certbot renew --dry-run` zum Prüfen). Ohne
Zertifikat startet der Nginx-Container mit der HTTPS-Vorlage bewusst nicht – es gibt keinen stillen Rückfall auf HTTP.

## Betrieb ohne Domain (HTTPS über die IP-Adresse) – ab 1.2.1

Ohne Domain stellt Let's Encrypt kein Zertifikat aus. Berichtly Server verschlüsselt die Verbindung trotzdem mit
HTTPS: Bei der Installation erzeugt der Server ein **eigenes Zertifikat für seine IP-Adresse**. Weil kein Browser
und kein Android-Gerät diesem Zertifikat von sich aus vertraut, bekommt die App zusätzlich den **Fingerabdruck
(Pin)** des Server-Schlüssels und akzeptiert dann nur genau diesen Server (Certificate Pinning). Das ist genauso
sicher wie ein öffentliches Zertifikat – solange der Fingerabdruck auf einem vertrauenswürdigen Weg in die App
kommt (vom eigenen Bildschirm abgelesen bzw. per QR-Code gescannt).

| | |
|---|---|
| Einrichtung | automatisch durch `deploy/setup.sh` ohne Domain (bzw. `install-from-github.sh`) |
| Schlüssel und Zertifikat | `/etc/berichtly-server/tls/server.key` (nur root) und `server.crt`; nie im Repository |
| Erzeugt mit | `deploy/tls-selfsigned.sh <ip>`: EC P-256, 10 Jahre gültig, `subjectAltName=IP:<ip>` |
| Nginx | Vorlage `berichtly-ip.conf.template` (TLS 1.2/1.3, HTTP→HTTPS, sonst wie mit Domain) |
| Fingerabdruck anzeigen | `berichtly-server tls-pin` (Adresse, Pin, Ablaufdatum), `berichtly-server tls-pin --uri` (für QR-Code) |
| Format des Pins | `sha256/<Base64>` = SHA-256 über den öffentlichen Schlüssel (SubjectPublicKeyInfo), wie bei OkHttp |
| Verbindungsdaten | `berichtly://server?url=https%3A%2F%2F<ip>&pin=sha256%2F…` (Inhalt des QR-Codes) |

**Der Fingerabdruck ändert sich nie von selbst.** `tls-selfsigned.sh` erzeugt den Schlüssel nur einmal. Ändert sich
die IP-Adresse des Servers oder läuft das Zertifikat in weniger als 30 Tagen ab, wird es beim nächsten Aufruf von
`setup.sh` mit **demselben Schlüssel** neu ausgestellt – der Pin in der App bleibt gültig. Nur wer
`/etc/berichtly-server/tls/server.key` löscht oder ersetzt, erhält einen neuen Fingerabdruck; dann müssen alle
Apps neu verbunden werden. Den Schlüssel deshalb zusammen mit der Konfiguration sichern ([BACKUP.md](BACKUP.md)).

Hinweise:

- **Browser** zeigen bei `https://<ip>` eine Zertifikatswarnung. Das ist bei einem eigenen Zertifikat normal und
  betrifft die App nicht. Wer im Browser prüfen möchte, vergleicht den SHA-256-Fingerabdruck des Zertifikats mit der
  Ausgabe von `berichtly-server tls-pin`.
- **HSTS** wird mitgesendet, Browser ignorieren es bei IP-Adressen aber (so vorgesehen).
- **Private Adresse** (z. B. `192.168.…` im Heimnetz): Die App erreicht den Server dann nur im selben Netz. Für den
  Zugriff aus dem Internet die öffentliche IP angeben (`setup.sh <öffentliche-ip>`) und am Router die Ports 80 und
  443 an den Server weiterleiten.
- **Neue IP-Adresse** (z. B. Umzug zu einem anderen Server-Tarif): `setup.sh <neue-ip>` ausführen; in der App nur die
  Adresse ändern, der Fingerabdruck bleibt gleich.
- **Später doch eine Domain:** `setup.sh <domain> <e-mail>` stellt auf Let's Encrypt um; die App braucht dann keinen
  Pin mehr.
- **Docker Compose:** Zertifikat auf dem Host erzeugen (`sudo sh deploy/tls-selfsigned.sh <ip>`), in `.env`
  `NGINX_CONFIG=ip` und `BERICHTLY_DOMAIN=<ip>` setzen, dann `docker compose up -d`. Der Nginx-Container bindet
  `/etc/berichtly-server/tls` (`TLS_DIR`) nur lesend ein.

Wie die Android-App das Pinning umsetzt: [API.md](API.md), Abschnitt "Verbindung ohne Domain".

Getestet in `test/nginx/nginx.test.ts` (Betriebsart `ip`): Verbindung nur mit richtigem Pin, falscher Pin und
Verbindungen ohne Pin (wie ein Browser) werden abgelehnt; dazu alle API-Prüfungen wie mit Domain.
`test/unit/tls.test.ts` prüft, dass der Pin bei Verlängerung und neuer IP gleich bleibt.

## IPv6

`install-nginx.sh` aktiviert die IPv6-Listener automatisch, wenn der Host IPv6 hat. Im Docker-Container bleiben sie
aus: Docker veröffentlicht die Ports standardmäßig auf allen Adressen des Hosts und leitet auch IPv6-Verbindungen
an den Container weiter. Nach dem Einrichten mit `curl -6 -I https://<domain>/api/v1/health` prüfen, falls die
Domain einen AAAA-Eintrag hat.
