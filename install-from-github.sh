#!/bin/sh
# Berichtly Server – Installation und Update direkt von GitHub mit einem Befehl (Debian/Ubuntu, als root):
#
#   curl -fsSL https://raw.githubusercontent.com/Pizzakaufen/BerichtlyServer/main/install-from-github.sh | sh
#
# Fragt beim ersten Mal nach Domain und E-Mail (für Let's Encrypt) und merkt sich beides in
# /etc/berichtly-server/install.conf. Ein erneuter Aufruf desselben Befehls aktualisiert den Server ohne Fragen.
# Ohne Rückfragen:  ... | sh -s -- berichtly.example.de admin@example.de
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
    ask() { # ask PROMPT [secret] – liest vom Terminal, auch wenn das Skript über eine Pipe kommt
        [ -r /dev/tty ] || fail "Keine Eingabe möglich. Domain und E-Mail als Argumente übergeben: ... | sh -s -- <domain> <e-mail>"
        printf '%s' "$1" > /dev/tty
        if [ "${2:-}" = secret ]; then
            stty -echo < /dev/tty
            IFS= read -r ANSWER < /dev/tty || ANSWER=""
            stty echo < /dev/tty
            printf '\n' > /dev/tty
        else
            IFS= read -r ANSWER < /dev/tty || ANSWER=""
        fi
    }
    saved() { [ -r "$STATE" ] && sed -n "s/^$1=//p" "$STATE" | tail -n 1 || true; }
    git_auth() { # git mit Token nur für diesen Aufruf (wird nicht in .git/config gespeichert)
        if [ -n "$TOKEN" ]; then
            git -c "http.https://github.com/.extraheader=AUTHORIZATION: basic $(printf 'x-access-token:%s' "$TOKEN" | base64 | tr -d '\n')" "$@"
        else
            git "$@"
        fi
    }

    [ "$(id -u)" -eq 0 ] || fail "Bitte als root ausführen (z. B. erst 'sudo -i')."
    command -v apt-get >/dev/null 2>&1 || fail "Nur für Debian/Ubuntu. Andere Systeme: docs/DEPLOYMENT.md im Repository."

    DOMAIN="${1:-$(saved DOMAIN)}"
    EMAIL="${2:-$(saved EMAIL)}"
    if [ -z "$DOMAIN" ]; then ask "Domain des Servers (z. B. berichtly.example.de): "; DOMAIN="$ANSWER"; fi
    if [ -z "$EMAIL" ]; then ask "E-Mail für das HTTPS-Zertifikat (Let's Encrypt): "; EMAIL="$ANSWER"; fi
    [ -n "$DOMAIN" ] && [ -n "$EMAIL" ] || fail "Domain und E-Mail werden benötigt."

    echo "==> Git installieren"
    apt-get update -q < /dev/null
    DEBIAN_FRONTEND=noninteractive apt-get install -y -q git ca-certificates < /dev/null

    # Öffentlich oder privat? Ohne Token prüfen, ob das Repository ohne Anmeldung lesbar ist.
    if [ -z "$TOKEN" ] && ! GIT_TERMINAL_PROMPT=0 git ls-remote "$REPO_URL" >/dev/null 2>&1; then
        ask "GitHub-Token (Repository ist privat; Eingabe wird nicht angezeigt): " secret
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

    # Domain und E-Mail für spätere Updates merken (kein Token, keine Passwörter).
    mkdir -p /etc/berichtly-server
    printf 'DOMAIN=%s\nEMAIL=%s\n' "$DOMAIN" "$EMAIL" > "$STATE"
    chmod 0600 "$STATE"

    sh "$SRC/deploy/setup.sh" "$DOMAIN" "$EMAIL" < /dev/null
}

main "$@"
