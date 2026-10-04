#!/bin/sh
# Installiert bzw. aktualisiert Berichtly Server als systemd-Dienst.
#
# Aufruf im entpackten Release-Archiv (oder im Projektverzeichnis nach "make build"):
#   sudo ./deploy/install.sh
#
# Das Skript ist idempotent: Benutzer und Verzeichnisse werden nur angelegt, wenn sie fehlen,
# eine vorhandene Konfiguration wird nie überschrieben. Ein laufender Dienst wird nach einem
# Update neu gestartet.
set -eu

APP_DIR=/opt/berichtly-server
CONF_DIR=/etc/berichtly-server
CONF_FILE=$CONF_DIR/berichtly-server.env
SERVICE=berichtly-server

cd "$(dirname "$0")/.."

if [ "$(id -u)" -ne 0 ]; then
    echo "Bitte mit sudo ausführen." >&2
    exit 1
fi
if [ "$(uname -s)" != "Linux" ]; then
    echo "Dieses Skript ist nur für Linux gedacht." >&2
    exit 1
fi

# Binärdatei finden: im Release-Archiv liegt sie im Hauptverzeichnis, im Quellcode unter bin/.
if [ -x ./berichtly-server ]; then
    BINARY=./berichtly-server
elif [ -x ./bin/berichtly-server ]; then
    BINARY=./bin/berichtly-server
else
    echo "Binärdatei nicht gefunden. Release-Archiv verwenden oder zuerst 'make build' ausführen." >&2
    exit 1
fi

# Eingeschränkter Systembenutzer ohne Login-Shell und ohne Home-Verzeichnis.
if ! id berichtly >/dev/null 2>&1; then
    useradd --system --user-group --no-create-home --home-dir "$APP_DIR" --shell /usr/sbin/nologin berichtly
    echo "Systembenutzer 'berichtly' angelegt."
fi

# Programmdateien gehören root und sind für den Dienst nur lesbar.
install -d -m 0755 -o root -g root "$APP_DIR"
install -m 0755 -o root -g root "$BINARY" "$APP_DIR/berichtly-server.new"
mv "$APP_DIR/berichtly-server.new" "$APP_DIR/berichtly-server"
install -m 0644 -o root -g root README.md "$APP_DIR/README.md"
if [ -d docs ]; then
    install -d -m 0755 -o root -g root "$APP_DIR/docs"
    install -m 0644 -o root -g root docs/*.md "$APP_DIR/docs/"
fi

# Konfiguration mit Secrets: nur root und der Dienstbenutzer dürfen sie lesen.
install -d -m 0750 -o root -g berichtly "$CONF_DIR"
if [ ! -f "$CONF_FILE" ]; then
    install -m 0640 -o root -g berichtly .env.example "$CONF_FILE"
    sed -i \
        -e 's/^APP_ENV=.*/APP_ENV=production/' \
        -e 's/^LOG_LEVEL=.*/LOG_LEVEL=info/' \
        -e 's/^LOG_FORMAT=.*/LOG_FORMAT=json/' \
        -e 's/^API_DOCS_ENABLED=.*/API_DOCS_ENABLED=false/' \
        "$CONF_FILE"
    echo "Konfiguration angelegt: $CONF_FILE – bitte DB_PASSWORD und JWT_SECRET setzen!"
fi

install -m 0644 -o root -g root deploy/systemd/berichtly-server.service /etc/systemd/system/$SERVICE.service
systemctl daemon-reload

if systemctl is-active --quiet $SERVICE; then
    runuser -u berichtly -- "$APP_DIR/berichtly-server" --env-file "$CONF_FILE" migrate
    systemctl restart $SERVICE
    echo "Update installiert und Dienst neu gestartet ($("$APP_DIR/berichtly-server" version))."
    exit 0
fi

cat <<EOT

Installiert: $("$APP_DIR/berichtly-server" version)

Nächste Schritte:
  1. Konfiguration bearbeiten:  sudo nano $CONF_FILE
       (mindestens DB_PASSWORD und JWT_SECRET – erzeugen mit: openssl rand -base64 48)
  2. Prüfen:                    sudo -u berichtly $APP_DIR/berichtly-server --env-file $CONF_FILE check-config
  3. Datenbank prüfen:         sudo -u berichtly $APP_DIR/berichtly-server --env-file $CONF_FILE db-check
     Migrationen:               sudo -u berichtly $APP_DIR/berichtly-server --env-file $CONF_FILE migrate
  4. Dienst starten:            sudo systemctl enable --now $SERVICE
  5. Status:                    systemctl status $SERVICE ; journalctl -u $SERVICE -f
EOT
