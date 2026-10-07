#!/bin/sh
# Installiert bzw. aktualisiert Berichtly Server 1.2 (Node.js) als systemd-Dienst.
#
# Aufruf im entpackten Release-Archiv oder im Projektverzeichnis:
#   sudo ./deploy/install.sh
#
# Voraussetzungen: Linux mit systemd, Node.js >= 24 unter /usr/bin/node, PostgreSQL (lokal oder entfernt).
# Nginx wird separat eingerichtet: sudo ./deploy/install-nginx.sh <domain>
#
# Das Skript ist idempotent: Benutzer und Verzeichnisse werden nur angelegt, wenn sie fehlen, eine vorhandene
# Konfiguration wird nie überschrieben (auch nicht die von 1.1). Ein laufender Dienst wird nach dem Update
# migriert und neu gestartet.
set -eu

APP_DIR=/opt/berichtly-server
CONF_DIR=/etc/berichtly-server
CONF_FILE=$CONF_DIR/berichtly-server.env
SERVICE=berichtly-server
NODE=/usr/bin/node

cd "$(dirname "$0")/.."

if [ "$(id -u)" -ne 0 ]; then
    echo "Bitte mit sudo ausführen." >&2
    exit 1
fi
if [ "$(uname -s)" != "Linux" ]; then
    echo "Dieses Skript ist nur für Linux gedacht." >&2
    exit 1
fi
if [ ! -x "$NODE" ]; then
    echo "Node.js nicht gefunden ($NODE). Bitte Node.js 24 LTS installieren (siehe docs/DEPLOYMENT.md)." >&2
    exit 1
fi
NODE_MAJOR=$("$NODE" -p 'process.versions.node.split(".")[0]')
if [ "$NODE_MAJOR" -lt 24 ]; then
    echo "Node.js $("$NODE" --version) ist zu alt – benötigt wird Version 24 LTS oder neuer." >&2
    exit 1
fi

# Laufzeitabhängigkeiten: im Release-Archiv bereits enthalten, sonst exakt nach package-lock.json installieren.
if [ ! -d node_modules/fastify ] || [ ! -d node_modules/pg ]; then
    if ! command -v npm >/dev/null 2>&1; then
        echo "node_modules fehlt und npm ist nicht installiert. Release-Archiv verwenden oder npm installieren." >&2
        exit 1
    fi
    npm ci --omit=dev --ignore-scripts
fi

# Eingeschränkter Systembenutzer ohne Login-Shell und ohne Home-Verzeichnis.
if ! id berichtly >/dev/null 2>&1; then
    useradd --system --user-group --no-create-home --home-dir "$APP_DIR" --shell /usr/sbin/nologin berichtly
    echo "Systembenutzer 'berichtly' angelegt."
fi

# Programmdateien gehören root und sind für den Dienst nur lesbar. Neue Version zuerst daneben ablegen und dann
# austauschen, damit ein laufender Dienst nie eine halb kopierte Installation sieht.
install -d -m 0755 -o root -g root "$APP_DIR"
STAGE="$APP_DIR.new"
rm -rf "$STAGE"
install -d -m 0755 -o root -g root "$STAGE"
cp -R src api bin node_modules package.json package-lock.json README.md "$STAGE/"
if [ -d docs ]; then cp -R docs "$STAGE/"; fi
chown -R root:root "$STAGE"
chmod -R u=rwX,go=rX "$STAGE"
chmod 0755 "$STAGE/bin/berichtly-server"
# 1.1 (Go) lag als einzelne Binärdatei in $APP_DIR – sie wird durch 1.2 ersetzt.
for item in src api bin node_modules docs package.json package-lock.json README.md; do
    rm -rf "${APP_DIR:?}/$item"
    if [ -e "$STAGE/$item" ]; then mv "$STAGE/$item" "$APP_DIR/$item"; fi
done
rm -rf "$STAGE" "$APP_DIR/berichtly-server"
ln -sf "$APP_DIR/bin/berichtly-server" /usr/local/bin/berichtly-server

# Konfiguration mit Secrets: nur root und der Dienstbenutzer dürfen sie lesen.
install -d -m 0750 -o root -g berichtly "$CONF_DIR"
if [ ! -f "$CONF_FILE" ]; then
    install -m 0640 -o root -g berichtly .env.example "$CONF_FILE"
    sed -i \
        -e 's/^APP_ENV=.*/APP_ENV=production/' \
        -e 's/^LOG_LEVEL=.*/LOG_LEVEL=info/' \
        -e 's/^LOG_FORMAT=.*/LOG_FORMAT=json/' \
        -e 's/^API_DOCS_ENABLED=.*/API_DOCS_ENABLED=false/' \
        -e 's/^TRUST_PROXY=.*/TRUST_PROXY=true/' \
        "$CONF_FILE"
    echo "Konfiguration angelegt: $CONF_FILE – bitte DB_PASSWORD und JWT_SECRET setzen!"
fi

install -m 0644 -o root -g root deploy/systemd/berichtly-server.service /etc/systemd/system/$SERVICE.service
systemctl daemon-reload

run_cli() {
    runuser -u berichtly -- "$NODE" "$APP_DIR/src/cli.ts" --env-file "$CONF_FILE" "$@"
}

if systemctl is-active --quiet $SERVICE; then
    run_cli migrate
    systemctl restart $SERVICE
    echo "Update installiert und Dienst neu gestartet ($("$NODE" "$APP_DIR/src/cli.ts" version))."
    exit 0
fi

cat <<EOT

Installiert: $("$NODE" "$APP_DIR/src/cli.ts" version)

Nächste Schritte:
  1. Konfiguration bearbeiten:  sudo nano $CONF_FILE
       (mindestens DB_PASSWORD und JWT_SECRET – erzeugen mit: openssl rand -base64 48)
  2. Prüfen:                    sudo -u berichtly berichtly-server --env-file $CONF_FILE check-config
  3. Datenbank prüfen:          sudo -u berichtly berichtly-server --env-file $CONF_FILE db-check
     Migrationen:               sudo -u berichtly berichtly-server --env-file $CONF_FILE migrate
  4. Dienst starten:            sudo systemctl enable --now $SERVICE
  5. Status:                    systemctl status $SERVICE ; journalctl -u $SERVICE -f
  6. Nginx/HTTPS einrichten:    sudo ./deploy/install-nginx.sh <domain>   (siehe docs/HTTPS.md)
EOT
