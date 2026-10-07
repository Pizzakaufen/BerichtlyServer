# Sicherheit – Berichtly Server 1.2

Ergebnis der Sicherheitsprüfung für 1.2 (Node.js hinter Nginx). Jede Maßnahme ist umgesetzt und – wo sinnvoll – durch
automatisierte Tests abgesichert (`test/**/*.test.ts`, gegen echte PostgreSQL und echtes Nginx).

| Bereich | Umsetzung | Tests |
|---|---|---|
| **Passwörter** | Argon2id (m = 19 MiB, t = 2, p = 1, 16 Byte Salt), PHC-Format, Vergleich in konstanter Zeit, automatisches Neu-Hashen bei stärkeren Parametern; nie Klartext in Datenbank oder Logs. Länge 10–128, nicht gleich E-Mail. Passwortänderung erfordert das aktuelle Passwort und beendet alle anderen Sitzungen. | `auth`, `devices`, `unit/security` |
| **Login-Schutz** | Gleiche Meldung für unbekannte E-Mail und falsches Passwort; Dummy-Hash gegen Zeitunterschiede; Kontosperre nach `LOGIN_MAX_FAILED_ATTEMPTS`; Rate Limit pro IP **und pro Konto** (Schlüssel ist ein Hash der E-Mail). | `auth`, `devices` |
| **Access Tokens** | JWT, ausschließlich HS256 (kein `none`), Prüfung von Signatur, `iss`, `aud`, `exp`, `iat`; bei **jedem** Request zusätzlich: Sitzung aktiv, Konto aktiv. | `auth` (fehlend, ungültig, fremd signiert, `none`, falscher Algorithmus, abgelaufen, unbekannte Sitzung), `unit/security` |
| **Refresh Tokens** | 256 Bit Zufall, nur SHA-256-Hash gespeichert, einmal verwendbar (Rotation), Wiederverwendung → Sitzung widerrufen + Sicherheitsereignis; Widerruf per Logout, "überall abmelden", Sitzung beenden, Gerät abmelden, Passwortänderung. | `auth`, `devices` |
| **Autorisierung / IDOR** | Jede Abfrage enthält die Benutzer-ID aus dem geprüften Token. Vom Client gesendete `userId`, Versionen, Zeitstempel oder Geräte-IDs in Berichten werden ignoriert. Fremde Berichte, Geräte, Sitzungen und Profile verhalten sich wie nicht vorhanden (`404`); Geräte-IDs sind nur pro Konto eindeutig, sodass gleiche IDs nie auf fremde Geräte zeigen. | `access`, `devices`, `dates-security` |
| **Synchronisierung** | Idempotente Operationen (keine Doppelausführung), keine stillen Überschreibungen, Operation-ID-Wiederverwendung wird erkannt, konsistenter Snapshot beim Abruf, Cursor-Ablauf nach Bereinigung/Wiederherstellung. | `sync`, `sync-scenarios`, `sync-consistency`, `upgrade` |
| **SQL-Injection** | Ausschließlich parametrisierte Abfragen; dynamische Filter erzeugen nur Platzhalter, Sortierrichtung aus fester Liste. | Code-Review, Filtertests |
| **Eingabevalidierung** | Feldgenau: Typen, Pflichtfelder, Längen in Zeichen, UUIDs, Datum inkl. Bereich, ISO-Wochen, Status, Zeitzone, Steuer- und NUL-Zeichen, `clientLocalId`-Muster; Body-Limit (Standard 1 MiB); nur `application/json`. | diverse |
| **Datenbank** | Check-Constraints, Unique-Indizes, Fremdschlüssel mit Kaskade; Migrationen mit Prüfsumme gegen nachträgliche Änderung; Server startet nicht mit veraltetem Schema. | `system`, `upgrade` |
| **Rate Limiting** | Login 10/min/IP + 5/min/Konto, Registrierung 5/min/IP, Refresh 30/min/IP, übrige API 300/min/IP (alles konfigurierbar); `429` mit `Retry-After`. | `auth`, `devices`, `system`, `unit/limiter`, `nginx` |
| **CORS** | Standardmäßig aus; nur explizit konfigurierte Origins; `*` in Produktion verboten. | `system`, `unit/config` |
| **HTTP-Header** | `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cross-Origin-Resource-Policy`, `Content-Security-Policy: default-src 'none'` für die API, `Cache-Control: no-store`, HSTS (von Nginx, nur über HTTPS, genau einmal); Node.js sendet keinen `Server`-Header, Nginx nur `nginx` ohne Version; Timeouts gegen langsame Clients in Nginx und Node.js. | `system`, `dates-security`, `nginx` |
| **Secrets** | Nur Umgebungsvariablen, keine Standardwerte, schwache `JWT_SECRET` verhindern den Start, Ausgaben ohne Secrets; `.env` in `.gitignore`; systemd-Unit enthält keine Secrets. | `unit/config` |
| **Fehlermeldungen** | Zentrale Fehlerbehandlung (Fastify-Error-Handler); nie Stacktraces/SQL/Pfade an Clients; Datenbankausfall → `503 SERVICE_UNAVAILABLE`; auch Fehler von Nginx (413, 429, 502–504, unbekannte Pfade) im API-Fehlerformat. | `auth`, `system` |
| **Logging** | Strukturiert (JSON in Produktion), UTC-Zeitstempel, Request-ID, Methode, Pfad, Status, Dauer, Benutzer-ID; keine Passwörter, Tokens, Bodies, Query-Werte oder Berichtsinhalte. | E2E-Prüfung der Logs |
| **Audit** | Tabelle `security_events`: Registrierung, Login erfolgreich/fehlgeschlagen, Kontosperre, Logout, Wiederverwendung von Refresh Tokens, Sitzung/Gerät widerrufen, Passwortänderung. Gespeichert werden nur Typ, Zeit und technische IDs – keine E-Mail, IP, Passwörter, Tokens oder Inhalte. Aufbewahrung `SECURITY_EVENT_RETENTION_DAYS`. Benutzer sehen ihre eigenen Ereignisse. | `devices` |
| **Datenminimierung** | Geräte: nur Name, Plattform, OS- und App-Version (keine Hardware-IDs, Standort); gelöschte Berichte verlieren ihren Inhalt sofort; Idempotenz-Einträge ohne Inhalte. | – |
| **Health/Status** | Öffentliche Checks nur mit `up`/`down`; Details unter `/internal/status` nur mit eigenem Token, sonst `404`. | `system`, `nginx` |
| **Transport (Nginx)** | Einziger öffentlicher Dienst; TLS 1.2/1.3 mit Forward Secrecy, HTTP→HTTPS (308), HSTS, `client_max_body_size 1m`, Grund-Rate-Limit pro IP (strenger für Auth), Verbindungslimit, `/internal/` gesperrt, nur `/api/` wird weitergeleitet, Zugriffslog ohne Query-Strings und Header. Zertifikate und Schlüssel nur unter `/etc/letsencrypt`, nie im Repository. | `nginx` (HTTP und HTTPS) |
| **Proxy-Vertrauen** | Node.js vertraut genau einem Proxy: Client-IP = letzter Eintrag von `X-Forwarded-For` (von Nginx angehängt), vom Client gefälschte Einträge zählen nicht; ohne `TRUST_PROXY` werden Forward-Header ignoriert. | `system`, `nginx` |
| **Betrieb** | Kein Root (systemd-Benutzer `berichtly`, Container-Benutzer `node`), systemd-Härtung, Container `read_only`, `cap_drop: ALL`, `no-new-privileges`; Node.js und PostgreSQL ohne öffentliche Ports (Bindung an `127.0.0.1` bzw. internes Docker-Netz); Abhängigkeiten per `npm ci --ignore-scripts` aus `package-lock.json`. | `nginx` (Node.js nur über Nginx erreichbar) |

## Bekannte Einschränkungen

- **Konto-Enumeration**: Die Registrierung meldet `EMAIL_ALREADY_REGISTERED`. Rate-limitiert; eine
  enumerationsfreie Registrierung erfordert E-Mail-Bestätigung (geplant).
- **Kontosperre** kann von Dritten ausgelöst werden (zeitlich begrenzt). Das Limit pro Konto verlangsamt
  Angriffe, verhindert aber nicht, dass jemand mit bekannter E-Mail-Adresse die Sperre auslöst.
- **Rate Limiting** in Node.js ist prozesslokal und setzt hinter Nginx `TRUST_PROXY=true` voraus. Steht vor Nginx
  ein weiterer Proxy oder ein CDN, muss Nginx die echte Client-IP mit dem `realip`-Modul übernehmen.
- **Parallele Refresh-Anfragen** mit demselben Refresh Token gelten als Wiederverwendung und beenden die Sitzung.
- **Keine Ende-zu-Ende-Verschlüsselung** der Berichtsinhalte; Transport per HTTPS, Daten im Klartext in PostgreSQL.
- Swagger UI (nur wenn aktiviert) lädt Skripte von `unpkg.com`; in Produktion standardmäßig aus.

## Empfohlene Produktionskonfiguration

```
APP_ENV=production
SERVER_HOST=127.0.0.1
SERVER_PORT=3000
TRUST_PROXY=true          # Node.js nur über Nginx erreichbar
API_DOCS_ENABLED=false
CORS_ALLOWED_ORIGINS=     # leer
JWT_SECRET=…              # openssl rand -base64 48, nie wiederverwenden
DB_SSLMODE=require        # wenn PostgreSQL auf einem anderen Host läuft
```

Ein Wechsel von `JWT_SECRET` macht alle Access Tokens ungültig; Refresh Tokens bleiben gültig (sie werden
unabhängig davon in der Datenbank geprüft). Bei Verdacht auf Kompromittierung eines Kontos: `POST /auth/logout-all`
bzw. Passwortänderung.
