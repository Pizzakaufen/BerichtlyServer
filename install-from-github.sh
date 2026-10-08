#!/bin/sh
# Berichtly Server – Installation und Update direkt von GitHub mit einem Befehl (Debian/Ubuntu, als root):
#
#   curl -fsSL https://raw.githubusercontent.com/Pizzakaufen/BerichtlyServer/main/install-from-github.sh | sh
#
# Ohne weitere Angaben läuft der Server ohne Domain über die IP-Adresse (HTTPS mit eigenem Zertifikat; die App
# bekommt Adresse und Fingerabdruck, auch als QR-Code). Es gibt keine Rückfragen.
#
#   ... | sh -s -- 203.0.113.10                         bestimmte IP-Adresse verwenden
#   ... | sh -s -- berichtly.example.de admin@x.de      mit eigener Domain und Let's-Encrypt-Zertifikat
#
# Die Auswahl wird in /etc/berichtly-server/install.conf gespeichert; ein erneuter Aufruf desselben Befehls
# aktualisiert den Server mit denselben Einstellungen.
#
# Privates Repository: Das Skript fragt nach einem GitHub-Token (Leserecht genügt) oder liest GITHUB_TOKEN. Der Token
# wird nur für den Download verwendet und nirgends gespeichert.
#
# Alles ist in einer Funktion, damit die Shell das Skript vollständig gelesen hat, bevor etwas ausgeführt wird
# (wichtig beim Aufruf über "curl | sh").

main() {
    set -eu
    REPO_URL="https://github.com/Pizzakaufen/BerichtlyServer.git"
    BRANCH="${BERICHTLY_BRANCH:-main}"
    SRC=/opt/berichtly-src
    STATE=/etc/berichtly-server/install.conf
    TOKEN="${GITHUB_TOKEN:-}"

    fail() { printf '\nFEHLER: %s\n' "$*" >&2; exit 1; }
    ask_secret() { # liest vom Terminal, auch wenn das Skript über eine Pipe kommt
        [ -r /dev/tty ] || fail "Keine Eingabe möglich. Token als GITHUB_TOKEN übergeben."
        printf '%s' "$1" > /dev/tty
        stty -echo < /dev/tty
        IFS= read -r ANSWER < /dev/tty || ANSWER=""
        stty echo < /dev/tty
        printf '\n' > /dev/tty
    }
    saved() { if [ -r "$STATE" ]; then sed -n "s/^$1=//p" "$STATE" | tail -n 1; fi; }
    git_auth() { # git mit Token nur für diesen Aufruf (wird nicht in .git/config gespeichert)
        if [ -n "$TOKEN" ]; then
            git -c "http.https://github.com/.extraheader=AUTHORIZATION: basic $(printf 'x-access-token:%s' "$TOKEN" | base64 | tr -d '\n')" "$@"
        else
            git "$@"
        fi
    }

    [ "$(id -u)" -eq 0 ] || fail "Bitte als root ausführen (z. B. erst 'sudo -i')."
    command -v apt-get >/dev/null 2>&1 || fail "Nur für Debian/Ubuntu. Andere Systeme: docs/DEPLOYMENT.md im Repository."

    # Einstellungen: Argumente > gespeicherte Auswahl > Betrieb über die IP-Adresse.
    TARGET="${1:-}"
    EMAIL="${2:-}"
    if [ -z "$TARGET" ]; then
        TARGET="$(saved ADDRESS)"
        EMAIL="$(saved EMAIL)"
        OLD_DOMAIN="$(saved DOMAIN)"   # Format bis 1.2
        if [ -z "$TARGET" ] && [ -n "$OLD_DOMAIN" ] && [ -f "/etc/letsencrypt/live/$OLD_DOMAIN/fullchain.pem" ]; then
            TARGET="$OLD_DOMAIN"   # Domain mit vorhandenem Zertifikat weiter verwenden
        fi
    fi

    echo "==> Git installieren"
    apt-get update -q < /dev/null
    DEBIAN_FRONTEND=noninteractive apt-get install -y -q git ca-certificates < /dev/null

    # Öffentlich oder privat? Ohne Token prüfen, ob das Repository ohne Anmeldung lesbar ist.
    if [ -z "$TOKEN" ] && ! GIT_TERMINAL_PROMPT=0 git ls-remote "$REPO_URL" >/dev/null 2>&1; then
        ask_secret "GitHub-Token (Repository ist privat; Eingabe wird nicht angezeigt): "
        TOKEN="$ANSWER"
        [ -n "$TOKEN" ] || fail "Ohne Token kann das private Repository nicht geladen werden."
    fi

    if [ -d "$SRC/.git" ]; then
        echo "==> Neueste Version von GitHub holen"
        git_auth -C "$SRC" fetch --depth 1 origin "$BRANCH" < /dev/null || fail "Download von GitHub fehlgeschlagen (Token/Internet prüfen)."
        git -C "$SRC" checkout -q -B "$BRANCH" FETCH_HEAD
        git -C "$SRC" reset -q --hard FETCH_HEAD
    else
        echo "==> Berichtly Server von GitHub laden"
        git_auth clone -q --depth 1 --branch "$BRANCH" "$REPO_URL" "$SRC" < /dev/null \
            || fail "Download von GitHub fehlgeschlagen (Token/Internet prüfen)."
    fi
    echo "Version: $(cat "$SRC/VERSION")"

    # Auswahl für spätere Updates merken (kein Token, keine Passwörter). Leere Adresse = IP automatisch erkennen.
    mkdir -p /etc/berichtly-server
    printf 'ADDRESS=%s\nEMAIL=%s\n' "$TARGET" "$EMAIL" > "$STATE"
    chmod 0600 "$STATE"

    if [ -n "$TARGET" ]; then
        sh "$SRC/deploy/setup.sh" "$TARGET" "$EMAIL" < /dev/null
    else
        sh "$SRC/deploy/setup.sh" < /dev/null
    fi
}

main "$@"
