#!/bin/sh
# Richtet Nginx als einzigen öffentlichen Zugang zu Berichtly Server 1.2 ein (Linux, Debian/Ubuntu-Layout).
#
#   sudo ./deploy/install-nginx.sh <domain> [http|https]
#
#   http   nur für die Ersteinrichtung: beantwortet die Let's-Encrypt-Prüfung, noch ohne TLS
#   https  Produktionsbetrieb (Standard); benötigt /etc/letsencrypt/live/<domain>/ – siehe docs/HTTPS.md
#
# Die Domain wird nur hier übergeben und in die Vorlage eingesetzt – sie steht nirgends fest im Code.
# Das Skript prüft die Konfiguration mit "nginx -t" und lädt Nginx nur neu, wenn sie gültig ist.
set -eu

DOMAIN="${1:-}"
MODE="${2:-https}"
CONF_FILE=/etc/berichtly-server/berichtly-server.env

cd "$(dirname "$0")/.."

if [ "$(id -u)" -ne 0 ]; then
    echo "Bitte mit sudo ausführen." >&2
    exit 1
fi
if ! printf '%s' "$DOMAIN" | grep -Eq '^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$'; then
    echo "Verwendung: $0 <domain> [http|https]   (z. B. $0 berichtly.example.de)" >&2
    exit 1
fi
case "$MODE" in http|https) ;; *) echo "Modus muss http oder https sein." >&2; exit 1 ;; esac
for cmd in nginx envsubst; do
    if ! command -v $cmd >/dev/null 2>&1; then
        echo "$cmd fehlt. Installation: sudo apt install nginx gettext-base" >&2
        exit 1
    fi
done
if [ "$MODE" = https ] && [ ! -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then
    echo "Kein Zertifikat unter /etc/letsencrypt/live/$DOMAIN/. Zuerst mit 'http' einrichten und das Zertifikat" >&2
    echo "beziehen (docs/HTTPS.md, Abschnitt Ersteinrichtung)." >&2
    exit 1
fi

# Port des Node.js-Servers aus dessen Konfiguration (Standard 3000; Installationen aus 1.1 nutzen oft 8080).
PORT=3000
if [ -r "$CONF_FILE" ]; then
    CONFIGURED=$(sed -n 's/^SERVER_PORT=\([0-9]\{1,5\}\)[[:space:]]*$/\1/p' "$CONF_FILE" | tail -n 1)
    if [ -n "$CONFIGURED" ]; then PORT=$CONFIGURED; fi
fi

install -d -m 0755 /etc/nginx/snippets /var/www/certbot
install -m 0644 deploy/nginx/snippets/berichtly-http-context.conf deploy/nginx/snippets/berichtly-api.conf \
    deploy/nginx/snippets/berichtly-proxy.conf /etc/nginx/snippets/

TARGET=/etc/nginx/sites-available/berichtly.conf
TMP="$TARGET.new"
BERICHTLY_DOMAIN="$DOMAIN" BERICHTLY_UPSTREAM="127.0.0.1:$PORT" \
    envsubst '${BERICHTLY_DOMAIN} ${BERICHTLY_UPSTREAM}' < "deploy/nginx/templates/berichtly-$MODE.conf.template" > "$TMP"
# IPv6 nur aktivieren, wenn der Host IPv6 hat.
if [ -s /proc/net/if_inet6 ]; then
    sed -i 's/^\([[:space:]]*\)#IPV6 /\1/' "$TMP"
fi
mv "$TMP" "$TARGET"
ln -sf "$TARGET" /etc/nginx/sites-enabled/berichtly.conf
# Upgrade von 1.1: die alte Seite (deploy/nginx/berichtly.conf, als "berichtly" ohne Endung aktiviert) würde mit
# derselben Domain kollidieren. Sie wird deaktiviert, die Datei in sites-available bleibt zur Ansicht erhalten.
if [ -L /etc/nginx/sites-enabled/berichtly ]; then
    rm /etc/nginx/sites-enabled/berichtly
    echo "Alte Nginx-Seite aus 1.1 deaktiviert (/etc/nginx/sites-available/berichtly bleibt erhalten)."
fi

if nginx -t; then
    systemctl reload nginx || systemctl restart nginx
    echo "Nginx eingerichtet ($MODE) für $DOMAIN → 127.0.0.1:$PORT"
else
    rm -f /etc/nginx/sites-enabled/berichtly.conf
    echo "Nginx-Konfiguration ungültig – nicht aktiviert. Fehler siehe oben." >&2
    exit 1
fi
if [ "$MODE" = http ]; then
    echo "ACHTUNG: Nur HTTP – Zertifikat jetzt beziehen und danach mit 'https' erneut ausführen (docs/HTTPS.md)."
fi
