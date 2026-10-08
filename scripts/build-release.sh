#!/bin/sh
# Baut das Linux-Release-Archiv von Berichtly Server 1.2 (Node.js).
#
#   ./scripts/build-release.sh            # Version aus VERSION-Datei
#
# Ergebnis (in dist/):
#   berichtly-server-<version>.tar.gz   Quellcode (TypeScript, direkt von Node.js ausgeführt), Laufzeitabhängigkeiten
#                                       (node_modules, reines JavaScript, keine nativen Module – daher für amd64
#                                       und arm64 gleich), Migrationen, OpenAPI, Konfigurationsbeispiel,
#                                       systemd-Unit, Nginx-Vorlagen, Installationsskripte und Doku.
#   SHA256SUMS
#
# Auf dem Server wird nur Node.js 24 LTS benötigt (kein npm, kein Internetzugang).
set -eu

cd "$(dirname "$0")/.."
VERSION="${VERSION:-$(cat VERSION)}"
PKG_VERSION="$(node -p 'require("./package.json").version')"
if [ "$VERSION" != "$PKG_VERSION" ]; then
    echo "VERSION ($VERSION) und package.json ($PKG_VERSION) stimmen nicht überein." >&2
    exit 1
fi
NAME="berichtly-server-$VERSION"
DIST=dist
STAGE="$DIST/$NAME"

echo "==> Prüfe Typen und Unit-Tests"
npx tsc --noEmit
npm run test:unit

rm -rf "$DIST"
mkdir -p "$STAGE"
cp -R src api bin deploy docs package.json package-lock.json .env.example README.md CHANGELOG.md VERSION "$STAGE/"
rm -rf "$STAGE/deploy/certbot"
echo "==> Installiere Laufzeitabhängigkeiten (npm ci --omit=dev)"
(cd "$STAGE" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null)
chmod 0755 "$STAGE/bin/berichtly-server" "$STAGE/deploy/install.sh" "$STAGE/deploy/install-nginx.sh" "$STAGE/deploy/setup.sh" "$STAGE/deploy/tls-selfsigned.sh"

tar -C "$DIST" --owner=0 --group=0 --numeric-owner -czf "$DIST/$NAME.tar.gz" "$NAME"
rm -rf "$STAGE"
(cd "$DIST" && sha256sum "$NAME.tar.gz" > SHA256SUMS)
echo "==> Fertig: $DIST/$NAME.tar.gz"
cat "$DIST/SHA256SUMS"
