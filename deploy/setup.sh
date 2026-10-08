#!/bin/sh
# Berichtly Server – Komplett-Einrichtung auf einem Debian-/Ubuntu-Server in einem Schritt.
#
#   sudo sh deploy/setup.sh                          ohne Domain: HTTPS über die IP-Adresse (automatisch erkannt)
#   sudo sh deploy/setup.sh 203.0.113.10             ohne Domain, IP-Adresse ausdrücklich angegeben
#   sudo sh deploy/setup.sh <domain> <e-mail>        mit Domain und Let's-Encrypt-Zertifikat
#
# Erledigt automatisch: Node.js 24, PostgreSQL und Nginx installieren, Datenbank anlegen, zufällige Passwörter und
# Schlüssel erzeugen (nur in /etc/berichtly-server/berichtly-server.env gespeichert, nie angezeigt), Server als
# systemd-Dienst starten, Firewall öffnen (falls ufw vorhanden) und HTTPS aktivieren:
#   - ohne Domain: eigenes Zertifikat für die IP-Adresse; die App vertraut dem Server über den angezeigten
#     Fingerabdruck (Certificate Pinning, auch als QR-Code)
#   - mit Domain:  Let's-Encrypt-Zertifikat mit automatischer Erneuerung
# Das Skript kann gefahrlos erneut ausgeführt werden (z. B. nach einem Fehler oder für Updates); Daten, Passwörter,
# Schlüssel und Zertifikate bleiben erhalten – auch der Fingerabdruck für die App.
set -eu

TARGET="${1:-}"
EMAIL="${2:-}"
CONF_FILE=/etc/berichtly-server/berichtly-server.env
TLS_DIR=/etc/berichtly-server/tls
SERVICE=berichtly-server

cd "$(dirname "$0")/.."

step() { printf '\n==> %s\n' "$*"; }
fail() { printf '\nFEHLER: %s\n' "$*" >&2; exit 1; }
is_ipv4() { printf '%s' "$1" | grep -Eq '^([0-9]{1,3}\.){3}[0-9]{1,3}$'; }

# --- Prüfungen und Betriebsart ---------------------------------------------------------------------------------
[ "$(id -u)" -eq 0 ] || fail "Bitte als root bzw. mit sudo ausführen."
command -v apt-get >/dev/null 2>&1 || fail "Dieses Skript ist für Debian/Ubuntu (apt) gedacht. Andere Systeme: docs/DEPLOYMENT.md."

if [ -z "$TARGET" ] || is_ipv4 "$TARGET"; then
    MODE=ip
    ADDRESS="$TARGET"
    if [ -z "$ADDRESS" ]; then
        # Adresse, über die der Server ins Internet geht (bei einem VPS die öffentliche IP).
        ADDRESS=$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -n 1)
        [ -n "$ADDRESS" ] || ADDRESS=$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^([0-9]{1,3}\.){3}[0-9]{1,3}$' | head -n 1)
        [ -n "$ADDRESS" ] || fail "IP-Adresse nicht erkannt. Bitte angeben: sh deploy/setup.sh <ip-adresse>"
    fi
    case "$ADDRESS" in
        10.*|192.168.*|172.1[6-9].*|172.2[0-9].*|172.3[01].*)
            echo "Hinweis: $ADDRESS ist eine private Adresse (Heim- oder Firmennetz). Die App erreicht den Server dann"
            echo "nur im selben Netz. Für Zugriff aus dem Internet die öffentliche IP angeben: sh deploy/setup.sh <ip>" ;;
    esac
else
    MODE=domain
    ADDRESS="$TARGET"
    printf '%s' "$ADDRESS" | grep -Eq '^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$' \
        || fail "Ungültige Domain oder IP-Adresse: $ADDRESS"
    if [ -z "$EMAIL" ]; then printf "E-Mail für Let's Encrypt (Ablauf-Hinweise): "; read -r EMAIL; fi
    printf '%s' "$EMAIL" | grep -Eq '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' || fail "Ungültige E-Mail-Adresse: $EMAIL"
    getent hosts "$ADDRESS" >/dev/null 2>&1 || echo "Warnung: $ADDRESS lässt sich (noch) nicht auflösen. Ohne DNS-Eintrag scheitert das Zertifikat."
fi
if [ "$MODE" = ip ]; then echo "Betriebsart: ohne Domain, HTTPS über https://$ADDRESS"; else echo "Betriebsart: Domain https://$ADDRESS"; fi

# --- 1. Pakete ---------------------------------------------------------------------------------------------
step "1/7 Pakete installieren (Node.js 24, PostgreSQL, Nginx)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q curl ca-certificates gnupg openssl iproute2
NODE_MAJOR=0
if command -v node >/dev/null 2>&1; then NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]'); fi
if [ "$NODE_MAJOR" -lt 24 ]; then
    # Offizielles NodeSource-Repository für Node.js 24 LTS (installiert /usr/bin/node).
    curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
fi
if [ "$MODE" = ip ]; then EXTRA=qrencode; else EXTRA=certbot; fi
apt-get install -y -q nodejs postgresql nginx gettext-base "$EXTRA"
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
set_conf BERICHTLY_DOMAIN "$ADDRESS"
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
if [ "$MODE" = ip ]; then
    step "6/7 Eigenes HTTPS-Zertifikat für $ADDRESS"
    sh deploy/tls-selfsigned.sh "$ADDRESS" "$TLS_DIR"
else
    step "6/7 HTTPS-Zertifikat (Let's Encrypt)"
    if [ ! -f "/etc/letsencrypt/live/$ADDRESS/fullchain.pem" ]; then
        sh deploy/install-nginx.sh "$ADDRESS" http >/dev/null
        if ! certbot certonly --webroot -w /var/www/certbot -d "$ADDRESS" --email "$EMAIL" --agree-tos --no-eff-email \
            --non-interactive --deploy-hook "systemctl reload nginx"; then
            # Ohne Zertifikat wird die API nicht über unverschlüsseltes HTTP angeboten.
            rm -f /etc/nginx/sites-enabled/berichtly.conf
            systemctl reload nginx
            fail "Zertifikat konnte nicht ausgestellt werden. Zeigt der DNS-Eintrag von $ADDRESS auf diesen Server und
       ist Port 80 von außen erreichbar? Danach dieses Skript einfach erneut ausführen.
       Ohne Domain geht es auch: sh deploy/setup.sh   (HTTPS über die IP-Adresse)"
        fi
    else
        echo "Zertifikat für $ADDRESS ist bereits vorhanden."
    fi
fi

# --- 7. Nginx mit HTTPS ------------------------------------------------------------------------------------
step "7/7 Nginx mit HTTPS aktivieren"
if [ "$MODE" = ip ]; then
    sh deploy/install-nginx.sh "$ADDRESS" ip
    CHECK="curl -fsS --cacert $TLS_DIR/server.crt https://$ADDRESS/api/v1/health"
else
    sh deploy/install-nginx.sh "$ADDRESS" https
    CHECK="curl -fsS --resolve $ADDRESS:443:127.0.0.1 https://$ADDRESS/api/v1/health"
fi
if $CHECK >/dev/null 2>&1; then
    HEALTH=OK
else
    HEALTH="nicht erreichbar – siehe journalctl -u $SERVICE und /var/log/nginx/error.log"
fi

cat <<EOT

==========================================================================
 Berichtly Server ist eingerichtet.

   Adresse für die App:  https://$ADDRESS
   Prüfung:              https://$ADDRESS/api/v1/health   ($HEALTH)
EOT
if [ "$MODE" = ip ]; then
    PIN=$(berichtly-server tls-pin --cert "$TLS_DIR/server.crt" | sed -n 's/^Fingerabdruck (Pin): *//p')
    cat <<EOT
   Fingerabdruck (Pin):  $PIN

 Die App braucht Adresse UND Fingerabdruck. Damit verbindet sie sich
 verschlüsselt und nur mit genau diesem Server. Zum Einscannen in der App:
EOT
    berichtly-server tls-pin --cert "$TLS_DIR/server.crt" --address "$ADDRESS" --uri | qrencode -t ANSIUTF8 || true
    cat <<EOT
 Später erneut anzeigen:  berichtly-server tls-pin
 Ein Browser zeigt bei https://$ADDRESS eine Zertifikatswarnung – das ist
 bei einem eigenen Zertifikat normal; maßgeblich ist der Fingerabdruck.
EOT
fi
cat <<EOT

   Status:      systemctl status $SERVICE
   Logs:        journalctl -u $SERVICE -f
   Neustart:    systemctl restart $SERVICE
   Update:      Installationsbefehl erneut ausführen

 Passwörter und Schlüssel stehen nur in $CONF_FILE und $TLS_DIR
 (sichern, aber nie weitergeben).
==========================================================================
EOT
