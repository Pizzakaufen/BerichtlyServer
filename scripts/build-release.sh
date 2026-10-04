#!/bin/sh
# Baut die Linux-Release-Archive von Berichtly Server.
#
#   ./scripts/build-release.sh            # Version aus VERSION-Datei
#   VERSION=1.0.0-alpha ./scripts/build-release.sh
#
# Ergebnis (in dist/):
#   berichtly-server-<version>-linux-amd64.tar.gz
#   berichtly-server-<version>-linux-arm64.tar.gz
#   SHA256SUMS
#
# Jedes Archiv enthält eine statisch gelinkte Binärdatei (keine Laufzeitabhängigkeiten, kein Java,
# keine glibc-Abhängigkeit) sowie Konfigurationsbeispiel, systemd-Service, Installationsskript und Doku.
set -eu

cd "$(dirname "$0")/.."
VERSION="${VERSION:-$(cat VERSION)}"
COMMIT="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
DIST=dist
NAME=berichtly-server

rm -rf "$DIST"
mkdir -p "$DIST"

for ARCH in amd64 arm64; do
    PKG="$NAME-$VERSION-linux-$ARCH"
    STAGE="$DIST/$PKG"
    echo "==> Baue $PKG"
    mkdir -p "$STAGE/deploy/systemd" "$STAGE/deploy/nginx" "$STAGE/deploy/caddy" "$STAGE/docs"
    CGO_ENABLED=0 GOOS=linux GOARCH="$ARCH" go build -trimpath \
        -ldflags "-s -w -X berichtly-server/internal/app.Version=$VERSION" \
        -o "$STAGE/$NAME" ./cmd/berichtly-server
    cp README.md CHANGELOG.md .env.example "$STAGE/"
    cp deploy/install.sh "$STAGE/deploy/"
    cp deploy/systemd/berichtly-server.service "$STAGE/deploy/systemd/"
    cp deploy/nginx/berichtly.conf "$STAGE/deploy/nginx/"
    cp deploy/caddy/Caddyfile "$STAGE/deploy/caddy/"
    cp docs/*.md "$STAGE/docs/"
    echo "$VERSION ($COMMIT)" > "$STAGE/VERSION"
    # Archiv mit festen Linux-Rechten, unabhängig vom Build-System (auch beim Bauen unter Windows):
    # Verzeichnisse 0755, Dateien 0644, Programme (Binärdatei, install.sh) 0755, Besitzer root.
    TAR="$DIST/$PKG.tar"
    tar --owner=0 --group=0 --numeric-owner --mode='u=rwX,go=rX' \
        --exclude="$PKG/$NAME" --exclude="$PKG/deploy/install.sh" \
        -C "$DIST" -cf "$TAR" "$PKG"
    tar --owner=0 --group=0 --numeric-owner --mode='0755' \
        -C "$DIST" -rf "$TAR" "$PKG/$NAME" "$PKG/deploy/install.sh"
    gzip -9 -n "$TAR"
    rm -rf "$STAGE"
done

(cd "$DIST" && sha256sum -b -- *.tar.gz | sed 's/ [*]/  /' > SHA256SUMS)
echo "==> Fertig:"
ls -l "$DIST"
