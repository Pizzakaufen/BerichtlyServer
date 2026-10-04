# Sicherheit – Berichtly Server 1.1

Ergebnis der Sicherheitsprüfung für 1.1. Jede Maßnahme ist umgesetzt und – wo sinnvoll – durch automatisierte
Tests abgesichert (`internal/**/*_test.go`).

| Bereich | Umsetzung | Tests |
|---|---|---|
| **Passwörter** | Argon2id (m = 19 MiB, t = 2, p = 1, 16 Byte Salt), PHC-Format, Vergleich in konstanter Zeit, automatisches Neu-Hashen bei stärkeren Parametern; nie Klartext in Datenbank oder Logs. Länge 10–128, nicht gleich E-Mail. Passwortänderung erfordert das aktuelle Passwort und beendet alle anderen Sitzungen. | `auth_test.go`, `devices_test.go`, `security_test.go` |
| **Login-Schutz** | Gleiche Meldung für unbekannte E-Mail und falsches Passwort; Dummy-Hash gegen Zeitunterschiede; Kontosperre nach `LOGIN_MAX_FAILED_ATTEMPTS`; Rate Limit pro IP **und pro Konto** (Schlüssel ist ein Hash der E-Mail). | `auth_test.go`, `devices_test.go` |
| **Access Tokens** | JWT, ausschließlich HS256 (kein `none`), Prüfung von Signatur, `iss`, `aud`, `exp`, `iat`; bei **jedem** Request zusätzlich: Sitzung aktiv, Konto aktiv. | `auth_test.go` (fehlend, ungültig, fremd signiert, `none`, abgelaufen, unbekannte Sitzung) |
| **Refresh Tokens** | 256 Bit Zufall, nur SHA-256-Hash gespeichert, einmal verwendbar (Rotation), Wiederverwendung → Sitzung widerrufen + Sicherheitsereignis; Widerruf per Logout, "überall abmelden", Sitzung beenden, Gerät abmelden, Passwortänderung. | `auth_test.go`, `devices_test.go` |
| **Autorisierung / IDOR** | Jede Abfrage enthält die Benutzer-ID aus dem geprüften Token. Vom Client gesendete `userId`, Versionen, Zeitstempel oder Geräte-IDs in Berichten werden ignoriert. Fremde Berichte, Geräte, Sitzungen und Profile verhalten sich wie nicht vorhanden (`404`); Geräte-IDs sind nur pro Konto eindeutig, sodass gleiche IDs nie auf fremde Geräte zeigen. | `access_test.go`, `devices_test.go`, `dates_security_test.go` |
| **Synchronisierung** | Idempotente Operationen (keine Doppelausführung), keine stillen Überschreibungen, Operation-ID-Wiederverwendung wird erkannt, konsistenter Snapshot beim Abruf, Cursor-Ablauf nach Bereinigung/Wiederherstellung. | `sync_*_test.go` |
| **SQL-Injection** | Ausschließlich parametrisierte Abfragen; dynamische Filter erzeugen nur Platzhalter, Sortierrichtung aus fester Liste. | Code-Review, Filtertests |
| **Eingabevalidierung** | Feldgenau: Typen, Pflichtfelder, Längen in Zeichen, UUIDs, Datum inkl. Bereich, ISO-Wochen, Status, Zeitzone, Steuer- und NUL-Zeichen, `clientLocalId`-Muster; Body-Limit (Standard 1 MiB); nur `application/json`. | diverse |
| **Datenbank** | Check-Constraints, Unique-Indizes, Fremdschlüssel mit Kaskade; Migrationen mit Prüfsumme gegen nachträgliche Änderung; Server startet nicht mit veraltetem Schema. | `system_test.go`, `upgrade_test.go` |
| **Rate Limiting** | Login 10/min/IP + 5/min/Konto, Registrierung 5/min/IP, Refresh 30/min/IP, übrige API 300/min/IP (alles konfigurierbar); `429` mit `Retry-After`. | `auth_test.go`, `devices_test.go`, `ratelimit_test.go` |
| **CORS** | Standardmäßig aus; nur explizit konfigurierte Origins; `*` in Produktion verboten. | `system_test.go`, `config_test.go` |
| **HTTP-Header** | `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cross-Origin-Resource-Policy`, `Content-Security-Policy: default-src 'none'` für die API, `Cache-Control: no-store`, HSTS hinter einem HTTPS-Reverse-Proxy (`TRUST_PROXY=true`), kein `Server`-Header; Timeouts gegen langsame Clients. | `system_test.go`, `dates_security_test.go` |
| **Secrets** | Nur Umgebungsvariablen, keine Standardwerte, schwache `JWT_SECRET` verhindern den Start, Ausgaben ohne Secrets; `.env` in `.gitignore`; systemd-Unit enthält keine Secrets. | `config_test.go` |
| **Fehlermeldungen** | Zentrale Fehlerbehandlung inkl. Panic-Recovery; nie Stacktraces/SQL/Pfade an Clients. | `auth_test.go`, `system_test.go` |
| **Logging** | Strukturiert (JSON in Produktion), UTC-Zeitstempel, Request-ID, Methode, Pfad, Status, Dauer, Benutzer-ID; keine Passwörter, Tokens, Bodies, Query-Werte oder Berichtsinhalte. | E2E-Prüfung der Logs |
| **Audit** | Tabelle `security_events`: Registrierung, Login erfolgreich/fehlgeschlagen, Kontosperre, Logout, Wiederverwendung von Refresh Tokens, Sitzung/Gerät widerrufen, Passwortänderung. Gespeichert werden nur Typ, Zeit und technische IDs – keine E-Mail, IP, Passwörter, Tokens oder Inhalte. Aufbewahrung `SECURITY_EVENT_RETENTION_DAYS`. Benutzer sehen ihre eigenen Ereignisse. | `devices_test.go` |
| **Datenminimierung** | Geräte: nur Name, Plattform, OS- und App-Version (keine Hardware-IDs, Standort); gelöschte Berichte verlieren ihren Inhalt sofort; Idempotenz-Einträge ohne Inhalte. | – |
| **Health/Status** | Öffentliche Checks nur mit `up`/`down`; Details unter `/internal/status` nur mit eigenem Token, sonst `404`. | `system_test.go` |
| **Betrieb** | Kein Root (systemd-Benutzer `berichtly`, Container `nonroot`), systemd-Härtung, Container ohne Shell, `read_only`, `cap_drop: ALL`; PostgreSQL nicht öffentlich; Bindung an `127.0.0.1`. | – |

## Bekannte Einschränkungen

- **Konto-Enumeration**: Die Registrierung meldet `EMAIL_ALREADY_REGISTERED`. Rate-limitiert; eine
  enumerationsfreie Registrierung erfordert E-Mail-Bestätigung (geplant).
- **Kontosperre** kann von Dritten ausgelöst werden (zeitlich begrenzt). Das Limit pro Konto verlangsamt
  Angriffe, verhindert aber nicht, dass jemand mit bekannter E-Mail-Adresse die Sperre auslöst.
- **Rate Limiting** ist prozesslokal und setzt hinter einem Reverse Proxy `TRUST_PROXY=true` voraus.
- **Parallele Refresh-Anfragen** mit demselben Refresh Token gelten als Wiederverwendung und beenden die Sitzung.
- **Keine Ende-zu-Ende-Verschlüsselung** der Berichtsinhalte; Transport per HTTPS, Daten im Klartext in PostgreSQL.
- Swagger UI (nur wenn aktiviert) lädt Skripte von `unpkg.com`; in Produktion standardmäßig aus.

## Empfohlene Produktionskonfiguration

```
APP_ENV=production
SERVER_HOST=127.0.0.1
TRUST_PROXY=true          # nur hinter Nginx/Caddy/Traefik
API_DOCS_ENABLED=false
CORS_ALLOWED_ORIGINS=     # leer
JWT_SECRET=…              # openssl rand -base64 48, nie wiederverwenden
DB_SSLMODE=require        # wenn PostgreSQL auf einem anderen Host läuft
```

Ein Wechsel von `JWT_SECRET` macht alle Access Tokens ungültig; Refresh Tokens bleiben gültig (sie werden
unabhängig davon in der Datenbank geprüft). Bei Verdacht auf Kompromittierung eines Kontos: `POST /auth/logout-all`
bzw. Passwortänderung.
