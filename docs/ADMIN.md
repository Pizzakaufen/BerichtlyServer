# Admin-Dashboard (seit Server 2.0)

Ein geschützter Verwaltungsbereich unter `/admin`: Serverstatus, Benutzerverwaltung, Synchronisierungshistorie und
Systemübersicht. Das Dashboard ist serverseitig gerendertes HTML ohne JavaScript und ohne zusätzlichen Build-Schritt.

> **Teststand:** Das Dashboard wurde für Server 2.0 geschrieben, aber in der Entwicklungsumgebung **nicht
> ausgeführt** (kein Node.js/PostgreSQL verfügbar). Vor dem produktiven Einsatz bitte `npm run typecheck` und
> `npm test` mit einer Testdatenbank ausführen (siehe „Tests“ unten).

## Aktivieren (drei Schritte, alle erforderlich)

1. **Konfiguration** (`/etc/berichtly-server/berichtly-server.env` bzw. `.env`):
   ```
   ADMIN_DASHBOARD_ENABLED=true
   ```
   Danach den Dienst neu starten. Ohne diese Einstellung existieren die Routen nicht (404).
2. **Administratorrechte** – nur per CLI, nie über die API oder das Dashboard selbst:
   ```bash
   sudo -u berichtly berichtly-server --env-file /etc/berichtly-server/berichtly-server.env admin grant du@example.de
   # Docker Compose:
   docker compose run --rm server admin grant du@example.de
   ```
   Das Konto muss vorher (z. B. über die App) registriert worden sein. `admin list` zeigt alle Administratoren,
   `admin revoke <E-Mail>` entzieht die Rechte – bestehende Dashboard-Sitzungen enden dann sofort.
3. **Nginx**: Nginx beantwortet alles außerhalb von `/api/` mit 404. Für das Dashboard im **HTTPS**-Server-Block
   ```nginx
   include /etc/nginx/snippets/berichtly-admin.conf;
   ```
   einkommentieren (Vorlage `berichtly-https.conf.template`), dann `nginx -t && systemctl reload nginx`.
   Empfehlung: im Snippet `allow`/`deny` auf Heimnetz oder VPN beschränken.

Im Betrieb ohne Domain (IP mit eigenem Zertifikat) akzeptiert der Browser das Zertifikat nicht von selbst – das
Dashboard dann nur über VPN bzw. SSH-Tunnel nutzen (`ssh -L 8443:127.0.0.1:443 server` und `https://localhost:8443/admin`
mit Ausnahme im Browser).

## Sicherheit

| Maßnahme | Umsetzung |
|---|---|
| Anmeldung | nur Konten mit Rolle `admin` und Status aktiv; gleiche Fehlermeldung für falsches Passwort und fehlende Rechte |
| Brute-Force | 5 Versuche pro IP und Minute (`RATE_LIMIT_ADMIN_LOGIN_PER_MINUTE`), Kontosperre nach Fehlversuchen wie bei der App, Nginx-Limit |
| Sitzung | Cookie `__Host-berichtly_admin`: `HttpOnly`, `Secure`, `SameSite=Strict`; 32 Zufallsbytes, gespeichert nur als SHA-256; Ende nach 30 min Leerlauf bzw. 8 h |
| CSRF | jedes Formular trägt das Token der Sitzung; zusätzlich Prüfung von `Origin` und `Sec-Fetch-Site` |
| Bestätigung | jede verändernde Aktion verlangt ein ausdrücklich gesetztes Häkchen (serverseitig geprüft) |
| Browser | strenge Content-Security-Policy (kein JavaScript, keine fremden Quellen), `X-Frame-Options: DENY`, `Cache-Control: no-store`, `noindex` |
| Protokoll | Anmeldung, Abmeldung, Sperren, Freigeben, Sitzungen beenden, Gerät abmelden → `admin_audit_log` (wer, was, an wem, wann); Rechtevergabe per CLI ebenfalls |
| Datensparsamkeit | sichtbar sind E-Mail, Status, Geräte, Zeitpunkte und Fehlercodes – nie Berichtsinhalte, Tokens oder Passwort-Hashes |

## Seiten

- **Übersicht:** Node.js (Version, Laufzeit), PostgreSQL (erreichbar, Version, Antwortzeit, Schema), ob die Anfrage
  über den vertrauenswürdigen Proxy kam, API-Fehler seit Start, Konten, aktive Geräte, Synchronisierungsstatus,
  Datenbankgröße und die letzten erfolgreichen Synchronisierungen.
  *Grenze:* Den Dienststatus von Nginx kann die API nicht sicher abfragen; angezeigt wird nur, ob die aktuelle
  Anfrage über ihn kam. Ausstehende Änderungen liegen auf den Geräten und sind dem Server unbekannt.
- **Benutzer:** Suche nach E-Mail, Status, Rolle, Geräte, letzte Anmeldung und Synchronisierung; Detailseite mit
  Geräten und den Aktionen *Konto sperren/freigeben*, *Alle Sitzungen beenden*, *Gerät abmelden*. Das eigene Konto
  lässt sich nicht sperren. Berichte bleiben bei allen Aktionen erhalten.
- **Synchronisierung:** je Gerät der zuletzt gemeldete Stand (Erfolg, Konflikt, Fehler mit Fehlercode) und die Zahl
  verarbeiteter Änderungen der letzten 24 h. Synchronisierungen starten immer auf dem Gerät; eine Wiederholung
  „vom Server aus“ sieht das Protokoll nicht vor – die App wiederholt automatisch.
- **System:** Server- und API-Version, Node.js, PostgreSQL, Migrationen, freier Speicher, protokollierte Backups und
  das Verwaltungsprotokoll.

## Tests

`test/integration/admin.test.ts` (nicht angemeldet, ohne Rechte, CSRF, fremde Herkunft, fehlende Bestätigung,
Audit, keine Berichtsinhalte, HTML-Maskierung, eigenes Konto, entzogene Rechte, Leerlauf) und
`test/unit/admin.test.ts` (Voreinstellungen, Maskierung, Token-Hash):

```bash
npm run typecheck
BERICHTLY_TEST_DATABASE_URL=postgres://berichtly:…@127.0.0.1:5432/berichtly_test npm test
```
