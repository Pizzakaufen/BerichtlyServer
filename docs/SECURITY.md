# Sicherheit – Berichtly Server 1.0 Alpha

Ergebnis der grundlegenden Sicherheitsprüfung. Jede Maßnahme ist umgesetzt und – wo sinnvoll – durch
automatisierte Tests abgesichert.

| Bereich | Umsetzung | Tests |
|---|---|---|
| **Passwörter** | Argon2id (m = 19 MiB, t = 2, p = 1, 16 Byte Salt), PHC-Format, Vergleich in konstanter Zeit; automatisches Neu-Hashen bei stärkeren Parametern; nie Klartext in Datenbank oder Logs. Länge 10–128 Zeichen, nicht gleich der E-Mail. | `auth_test.go`, `security_test.go` |
| **Login-Schutz** | Gleiche Meldung für unbekannte E-Mail und falsches Passwort; Dummy-Hash gegen Zeitunterschiede; vorübergehende Kontosperre nach `LOGIN_MAX_FAILED_ATTEMPTS`. | `auth_test.go` |
| **Access Tokens** | JWT, ausschließlich HS256 (kein `none`), Prüfung von Signatur, `iss`, `aud`, `exp`, `iat`; zusätzlich bei **jedem** Request: Sitzung aktiv und Konto aktiv → Logout wirkt sofort. | `auth_test.go` (fehlend, ungültig, fremd signiert, `none`, abgelaufen, unbekannte Sitzung) |
| **Refresh Tokens** | 256 Bit Zufall, nur SHA-256-Hash gespeichert, einmal verwendbar (Rotation), Ablauf 30 Tage, absolute Sitzungsdauer 180 Tage, Wiederverwendung → gesamte Sitzung widerrufen. | `auth_test.go` |
| **Autorisierung** | Jede Abfrage enthält die Benutzer-ID aus dem geprüften Token; fremde Datensätze liefern `404`; Push auf fremde IDs → `REJECTED`; ID-Kollisionen mit fremden Datensätzen geben keine Daten preis. | `access_test.go` |
| **SQL-Injection** | Ausschließlich parametrisierte Abfragen; dynamische Filter erzeugen nur Platzhalter, Sortierrichtung stammt aus einer festen Liste. | Code-Review, Filtertests |
| **Eingabevalidierung** | Feldgenau: Länge in Zeichen, Pflichtfelder, UUIDs, Datum inkl. Bereich, Status, Zeitzone, Steuer- und NUL-Zeichen, ungültiges UTF-8; Body-Limit (Standard 1 MiB); nur `application/json`. | `reports_test.go`, `access_test.go`, `system_test.go` |
| **Datenbank-Constraints** | Zusätzlich in PostgreSQL: Check-Constraints (Status, Montag als Wochenstart, Zeiträume, normalisierte E-Mail), Unique-Indizes, Fremdschlüssel mit Kaskade. | `system_test.go` |
| **Rate Limiting** | Auth-Endpunkte 10/min/IP, übrige API 300/min/IP (konfigurierbar), Antwort `429` mit `Retry-After`. | `auth_test.go`, `ratelimit_test.go` |
| **CORS** | Standardmäßig aus (die App braucht kein CORS); nur ausdrücklich konfigurierte Origins; `*` in Produktion verboten. | `system_test.go`, `config_test.go` |
| **Secrets** | Nur über Umgebungsvariablen, keine Standardwerte; zu kurze oder triviale `JWT_SECRET` verhindern den Start; Konfigurationsausgaben ohne Secrets; `.env` in `.gitignore`. | `config_test.go` |
| **Fehlermeldungen** | Zentrale Fehlerbehandlung inkl. Panic-Recovery; nie Stacktraces, SQL oder interne Meldungen an Clients. | `auth_test.go`, `system_test.go` |
| **Logging** | Nur Methode, Pfad, Status, Dauer, Request-ID und Benutzer-/Sitzungs-IDs; keine Passwörter, Tokens, Bodies oder Berichtsinhalte. | E2E-Prüfung der Logs |
| **Health/Status** | Öffentlicher Health-Check nur mit `up`/`down`; Details nur unter `/internal/status` mit eigenem Token (Vergleich in konstanter Zeit), sonst `404`. | `system_test.go` |
| **HTTP** | `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`; kein `Server`-Header; Timeouts gegen langsame Clients (Slowloris); Header-Größe begrenzt. | `system_test.go` |
| **Betrieb** | Kein Root (systemd-Benutzer `berichtly` bzw. Container-Benutzer `nonroot`), systemd-Härtung, Container ohne Shell und mit `read_only`/`cap_drop`, PostgreSQL nicht öffentlich, Bindung an `127.0.0.1`, HTTPS über Reverse Proxy. | – |

## Bekannte Einschränkungen (1.0 Alpha)

- **Konto-Enumeration**: Die Registrierung meldet `EMAIL_ALREADY_REGISTERED`, gesperrte Konten antworten mit
  `ACCOUNT_TEMPORARILY_LOCKED`. Beides ist rate-limitiert; eine enumerationsfreie Registrierung erfordert
  E-Mail-Bestätigung (geplant).
- **Kontosperre** kann von Dritten ausgelöst werden (Denial of Service auf ein Konto), ist aber zeitlich begrenzt.
- **Rate Limiting** ist prozesslokal und setzt hinter einem Reverse Proxy `TRUST_PROXY=true` voraus – sonst teilen
  sich alle Clients die IP des Proxys.
- **Parallele Refresh-Anfragen** mit demselben Refresh Token gelten als Wiederverwendung und beenden die Sitzung.
  Die App muss Refresh-Aufrufe serialisieren.
- **Keine Ende-zu-Ende-Verschlüsselung** der Berichtsinhalte: Transport per HTTPS, Daten liegen im Klartext in
  PostgreSQL. Festplattenverschlüsselung und Zugriffsschutz des Servers sind Aufgabe des Betreibers.
- Swagger UI (nur wenn aktiviert) lädt Skripte von `unpkg.com` im Browser des Entwicklers; in Produktion ist die
  Doku standardmäßig deaktiviert.

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

Ein Wechsel von `JWT_SECRET` macht alle Access Tokens ungültig; Refresh Tokens bleiben gültig, da sie unabhängig
davon in der Datenbank geprüft werden.
