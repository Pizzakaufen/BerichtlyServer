#!/bin/sh
# Berichtly Server 1.2 – Komplett-Einrichtung auf einem frischen Debian-/Ubuntu-Server in einem Schritt.
#
#   sudo sh deploy/setup.sh <domain> <e-mail>
#   z. B. sudo sh deploy/setup.sh berichtly.example.de admin@example.de
#
# Erledigt automatisch: Node.js 24, PostgreSQL, Nginx und Certbot installieren, Datenbank anlegen, zufällige
# Passwörter und Schlüssel erzeugen (nur in /etc/berichtly-server/berichtly-server.env gespeichert, nie angezeigt),
# Server als systemd-Dienst starten, Firewall öffnen (falls ufw vorhanden), Let's-Encrypt-Zertifikat holen und
# HTTPS aktivieren. Das Skript kann gefahrlos erneut ausgeführt werden (z. B. nach einem Fehler oder für Updates);
# vorhandene Daten, Passwörter und Zertifikate bleiben erhalten.
#
# Voraussetzung: Der DNS-Eintrag der Domain zeigt bereits auf diesen Server, Ports 80 und 443 sind erreichbar.
set -eu

DOMAIN="${1:-}"
EMAIL="${2:-}"
CONF_FILE=/etc/berichtly-server/berichtly-server.env
SERVICE=berichtly-server

cd "$(dirname "$0")/.."

step() { printf '\n==> %s\n' "$*"; }
fail() { printf '\nFEHLER: %s\n' "$*" >&2; exit 1; }

# --- Prüfungen ---------------------------------------------------------------------------------------------
[ "$(id -u)" -eq 0 ] || fail "Bitte als root bzw. mit sudo ausführen."
command -v apt-get >/dev/null 2>&1 || fail "Dieses Skript ist für Debian/Ubuntu (apt) gedacht. Andere Systeme: docs/DEPLOYMENT.md."
if [ -z "$DOMAIN" ]; then printf 'Domain (z. B. berichtly.example.de): '; read -r DOMAIN; fi
if [ -z "$EMAIL" ]; then printf "E-Mail für Let's Encrypt (Ablauf-Hinweise): "; read -r EMAIL; fi
printf '%s' "$DOMAIN" | grep -Eq '^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$' \
    || fail "Ungültige Domain: $DOMAIN"
printf '%s' "$EMAIL" | grep -Eq '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' || fail "Ungültige E-Mail-Adresse: $EMAIL"
if ! getent hosts "$DOMAIN" >/dev/null 2>&1; then
    echo "Warnung: $DOMAIN lässt sich (noch) nicht auflösen. Ohne DNS-Eintrag scheitert das Zertifikat."
fi

# --- 1. Pakete ---------------------------------------------------------------------------------------------
step "1/7 Pakete installieren (Node.js 24, PostgreSQL, Nginx, Certbot)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q curl ca-certificates gnupg openssl
NODE_MAJOR=0
if command -v node >/dev/null 2>&1; then NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]'); fi
if [ "$NODE_MAJOR" -lt 24 ]; then
    # Offizielles NodeSource-Repository für Node.js 24 LTS (installiert /usr/bin/node).
    curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
fi
apt-get install -y -q nodejs postgresql nginx certbot gettext-base
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 24 ] || fail "Node.js 24 konnte nicht installiert werden."
systemctl enable --now postgresql nginx >/dev/null

# --- 2. Programm installieren ------------------------------------------------------------------------------
step "2/7 Berichtly Server installieren"
sh deploy/install.sh >/dev/null
echo "Installiert: $(berichtly-server version)"

# --- 3. Datenbank und Secrets ------------------------------------------------------------------------------
step "3/7 Datenbank und Schlüssel einrichten"
set_conf() { # set_conf KEY WERT – ersetzt die Zeile KEY=... in der Konfiguration oder ergänzt sie
    if grep -q "^$1=" "$CONF_FILE"; then
        sed -i "s|^$1=.*|$1=$2|" "$CONF_FILE"
    else
        printf '%s=%s\n' "$1" "$2" >> "$CONF_FILE"
    fi
}
current() { sed -n "s/^$1=//p" "$CONF_FILE" | tail -n 1; }

DB_PW="$(current DB_PASSWORD)"
ROLE_EXISTS=$(runuser -u postgres -- psql -tAc "SELECT 1 FROM pg_roles WHERE rolname = 'berichtly'")
if [ -z "$DB_PW" ]; then
    DB_PW="$(openssl rand -hex 32)"
    if [ "$ROLE_EXISTS" = 1 ]; then
        runuser -u postgres -- psql -q -v ON_ERROR_STOP=1 -v pw="$DB_PW" <<'SQL'
ALTER ROLE berichtly WITH LOGIN PASSWORD :'pw';
SQL
    else
        runuser -u postgres -- psql -q -v ON_ERROR_STOP=1 -v pw="$DB_PW" <<'SQL'
CREATE ROLE berichtly LOGIN PASSWORD :'pw';
SQL
    fi
    set_conf DB_PASSWORD "$DB_PW"
    echo "Datenbankpasswort erzeugt und gespeichert."
fi
if [ "$(runuser -u postgres -- psql -tAc "SELECT 1 FROM pg_database WHERE datname = 'berichtly'")" != 1 ]; then
    runuser -u postgres -- createdb --owner=berichtly --encoding=UTF8 berichtly
    echo "Datenbank 'berichtly' angelegt."
fi
if [ -z "$(current JWT_SECRET)" ]; then
    set_conf JWT_SECRET "$(openssl rand -base64 48 | tr -d '\n')"
    echo "Token-Schlüssel (JWT_SECRET) erzeugt und gespeichert."
fi
set_conf BERICHTLY_DOMAIN "$DOMAIN"
chown root:berichtly "$CONF_FILE"
chmod 0640 "$CONF_FILE"

# --- 4. Server starten -------------------------------------------------------------------------------------
step "4/7 Server starten"
runuser -u berichtly -- berichtly-server --env-file "$CONF_FILE" check-config >/dev/null \
    || fail "Konfiguration ungültig: berichtly-server --env-file $CONF_FILE check-config"
runuser -u berichtly -- berichtly-server --env-file "$CONF_FILE" migrate
systemctl enable "$SERVICE" >/dev/null
systemctl restart "$SERVICE"
PORT="$(current SERVER_PORT)"
READY=no
for _ in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:${PORT:-3000}/api/v1/health/ready" >/dev/null 2>&1; then READY=yes; break; fi
    sleep 1
done
[ "$READY" = yes ] || fail "Server antwortet nicht. Logs: journalctl -u $SERVICE -n 50"
echo "Server läuft (nur intern auf 127.0.0.1:${PORT:-3000})."

# --- 5. Firewall -------------------------------------------------------------------------------------------
step "5/7 Firewall"
if command -v ufw >/dev/null 2>&1; then
    ufw allow OpenSSH >/dev/null
    ufw allow 80/tcp >/dev/null
    ufw allow 443/tcp >/dev/null
    ufw --force enable >/dev/null
    echo "ufw aktiv: SSH, 80 und 443 offen (Ports 3000 und 5432 bleiben geschlossen)."
else
    echo "ufw ist nicht installiert – Firewall bitte beim Hoster prüfen (nur 22, 80, 443 öffnen)."
fi

# --- 6. Zertifikat -----------------------------------------------------------------------------------------
step "6/7 HTTPS-Zertifikat (Let's Encrypt)"
if [ ! -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then
    sh deploy/install-nginx.sh "$DOMAIN" http >/dev/null
    if ! certbot certonly --webroot -w /var/www/certbot -d "$DOMAIN" --email "$EMAIL" --agree-tos --no-eff-email \
        --non-interactive --deploy-hook "systemctl reload nginx"; then
        # Ohne Zertifikat wird die API nicht über unverschlüsseltes HTTP angeboten.
        rm -f /etc/nginx/sites-enabled/berichtly.conf
        systemctl reload nginx
        fail "Zertifikat konnte nicht ausgestellt werden. Zeigt der DNS-Eintrag von $DOMAIN auf diesen Server und
       ist Port 80 von außen erreichbar? Danach dieses Skript einfach erneut ausführen."
    fi
else
    echo "Zertifikat für $DOMAIN ist bereits vorhanden."
fi

# --- 7. Nginx mit HTTPS ------------------------------------------------------------------------------------
step "7/7 Nginx mit HTTPS aktivieren"
sh deploy/install-nginx.sh "$DOMAIN" https
if curl -fsS --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/api/v1/health" >/dev/null 2>&1; then
    HEALTH=OK
else
    HEALTH="nicht erreichbar – siehe journalctl -u $SERVICE und /var/log/nginx/error.log"
fi

cat <<EOT

==========================================================================
 Berichtly Server ist eingerichtet.

   Adresse für die App:  https://$DOMAIN
   Prüfung:              https://$DOMAIN/api/v1/health   ($HEALTH)

   Status:      systemctl status $SERVICE
   Logs:        journalctl -u $SERVICE -f
   Neustart:    systemctl restart $SERVICE
   Update:      neues Paket entpacken und dieses Skript erneut ausführen

 Passwörter und Schlüssel stehen nur in $CONF_FILE
 (Datei sichern, aber nie weitergeben). Zertifikate erneuern sich automatisch.
==========================================================================
EOT
