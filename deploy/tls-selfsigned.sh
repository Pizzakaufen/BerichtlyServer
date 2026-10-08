#!/bin/sh
# Eigenes TLS-Zertifikat für den Betrieb ohne Domain (Zugriff über die IP-Adresse).
#
#   sudo sh deploy/tls-selfsigned.sh <ipv4-adresse> [verzeichnis]      (Standard: /etc/berichtly-server/tls)
#
# Erzeugt einmalig einen privaten Schlüssel (EC P-256, nur root lesbar) und dazu ein Zertifikat für die IP-Adresse
# (10 Jahre gültig). Die App vertraut dem Server über den Fingerabdruck dieses Schlüssels (Certificate Pinning,
# siehe docs/HTTPS.md). Bei erneutem Aufruf bleibt der Schlüssel immer erhalten – der Fingerabdruck in der App
# bleibt also gültig. Das Zertifikat wird nur neu ausgestellt, wenn es fehlt, die IP-Adresse sich geändert hat oder
# es in weniger als 30 Tagen abläuft.
#
# Schlüssel und Zertifikat gehören nie ins Git-Repository.
set -eu

IP="${1:-}"
DIR="${2:-/etc/berichtly-server/tls}"
KEY="$DIR/server.key"
CERT="$DIR/server.crt"

fail() { printf 'FEHLER: %s\n' "$*" >&2; exit 1; }
printf '%s' "$IP" | grep -Eq '^([0-9]{1,3}\.){3}[0-9]{1,3}$' || fail "Verwendung: $0 <ipv4-adresse> [verzeichnis]"
command -v openssl >/dev/null 2>&1 || fail "openssl fehlt (apt install openssl)."

umask 077
install -d -m 0755 "$DIR"
if [ ! -s "$KEY" ]; then
    openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$KEY" 2>/dev/null
    echo "Neuer privater Schlüssel erzeugt: $KEY"
fi
chmod 0600 "$KEY"

renew=no
if [ ! -s "$CERT" ]; then
    renew=yes
elif ! openssl x509 -in "$CERT" -noout -ext subjectAltName 2>/dev/null | grep -q "IP Address:$IP\$"; then
    echo "IP-Adresse im Zertifikat weicht ab – Zertifikat wird für $IP neu ausgestellt (gleicher Schlüssel)."
    renew=yes
elif ! openssl x509 -in "$CERT" -noout -checkend 2592000 >/dev/null 2>&1; then
    echo "Zertifikat läuft bald ab – wird mit demselben Schlüssel verlängert."
    renew=yes
fi

if [ "$renew" = yes ]; then
    openssl req -new -x509 -key "$KEY" -out "$CERT.new" -days 3650 -sha256 \
        -subj "/CN=$IP/O=Berichtly Server" \
        -addext "subjectAltName=IP:$IP" \
        -addext "basicConstraints=critical,CA:FALSE" \
        -addext "keyUsage=critical,digitalSignature" \
        -addext "extendedKeyUsage=serverAuth"
    mv "$CERT.new" "$CERT"
    echo "Zertifikat für $IP ausgestellt: $CERT"
fi
chmod 0644 "$CERT"
