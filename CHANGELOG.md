# Changelog

## 1.0.0-alpha – 2026-10-04

Erste Version von Berichtly Server als eigenständiges Linux-Backend.

- Statisch gelinkte Linux-Binärdatei (Go) für amd64 und arm64, ohne Laufzeitabhängigkeiten
- PostgreSQL mit eingebetteten, versionierten Migrationen (Prüfsummenkontrolle)
- Versionierte REST-API unter `/api/v1` mit einheitlichem Antwort- und Fehlerformat
- Konten: Registrierung, Login, Logout, Token-Erneuerung (Argon2id, JWT, rotierende Refresh Tokens)
- Profil, Tagesberichte, Wochenberichte, Wochenübersicht (Montag–Sonntag, zeitzonenbewusst)
- Synchronisationsgrundlage: Versionen, Änderungs-Cursor, Tombstones, Konfliktmeldungen, Sync-Status pro Gerät
- Geräteverwaltung (stabile Geräte-IDs, Sitzungen pro Gerät)
- Health-Check, geschützter interner Status, strukturiertes Logging, Request-IDs, Rate Limiting, kontrollierter Shutdown
- systemd-Service mit Härtung, Installationsskript, Docker-Image (distroless), Nginx/Caddy-Vorlagen
- Integrationstests gegen echte PostgreSQL
