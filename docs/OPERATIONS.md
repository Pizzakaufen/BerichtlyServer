# Betrieb: Logs, Log-Rotation, Monitoring – Berichtly Server 1.2

## Logs

| Quelle | Format | Ort (Linux direkt) | Ort (Docker Compose) |
|---|---|---|---|
| Node.js-Server | JSON pro Zeile (`LOG_FORMAT=json`), UTC | journald: `journalctl -u berichtly-server` | `docker compose logs server` |
| Nginx-Zugriffe | JSON pro Zeile (`berichtly_json`) | `/var/log/nginx/access.log` | `docker compose logs nginx` |
| Nginx-Fehler | Text | `/var/log/nginx/error.log` | `docker compose logs nginx` |
| PostgreSQL | Text | `journalctl -u postgresql`, `/var/log/postgresql/` | `docker compose logs db` |

Server-Logzeilen für Anfragen enthalten `request_id`, `method`, `path` (ohne Query-String), `status`,
`duration_ms`, `proto` (http/https zwischen App und Nginx) und – nach erfolgreicher Anmeldung – `user_id`.
Nginx loggt dieselbe `request_id`; so lassen sich beide Logs einer Anfrage zuordnen:

```bash
journalctl -u berichtly-server -o cat | grep '"request_id":"<id>"'
grep '"request_id":"<id>"' /var/log/nginx/access.log
```

Nie geloggt werden Passwörter, Tokens, `Authorization`-Header, Request-Bodies, Query-Werte oder Berichtsinhalte.

## Log-Rotation

- **journald** (Server, PostgreSQL): Größe begrenzen in `/etc/systemd/journald.conf`, z. B.
  `SystemMaxUse=500M` und `MaxRetentionSec=1month`, danach `sudo systemctl restart systemd-journald`.
  Aktuellen Platzbedarf anzeigen: `journalctl --disk-usage`.
- **Nginx**: Das Nginx-Paket von Debian/Ubuntu rotiert `/var/log/nginx/*.log` per logrotate täglich
  (`/etc/logrotate.d/nginx`, 14 Generationen, komprimiert). Prüfen: `sudo logrotate -d /etc/logrotate.d/nginx`.
- **Docker**: `docker-compose.yml` setzt für alle Dienste den Treiber `json-file` mit `max-size: 10m` und
  `max-file: 5` – ältere Logs werden automatisch verworfen.

## Health-Checks und Monitoring

| Prüfung | Antwort | Zweck |
|---|---|---|
| `GET https://<domain>/api/v1/health` | `200` gesund, `503` Datenbank nicht erreichbar | Uptime-Monitor (von außen, prüft auch TLS und Nginx) |
| `GET /api/v1/health/live` | `200`, ohne Datenbank | Liveness |
| `GET /api/v1/health/ready` | `200` nur bei erreichbarer Datenbank **und** aktuellem Schema | Readiness, Docker-Healthcheck, `berichtly-server healthcheck` |
| `GET http://127.0.0.1:3000/internal/status` mit `Authorization: Bearer $INTERNAL_STATUS_TOKEN` | Datenbanklatenz, Schema-Version, Pool-Auslastung, Speicher, freier Plattenplatz, Request- und Fehlerzähler | nur direkt auf dem Server; über Nginx immer `404` |
| `systemctl list-timers certbot.timer` | Erneuerung geplant | Zertifikatsablauf |

Öffentliche Health-Checks verraten keine Versionen, Hostnamen oder Fehlermeldungen.

## Häufige Situationen

| Symptom | Ursache / Maßnahme |
|---|---|
| App erhält `503 SERVICE_UNAVAILABLE` | Server startet neu, wird aktualisiert oder erreicht die Datenbank nicht: `systemctl status berichtly-server`, `journalctl -u berichtly-server -n 50`, `berichtly-server --env-file … db-check` |
| Server startet nicht: "Datenbankschema ist veraltet" | `DB_MIGRATE_ON_START=false` gesetzt und Migrationen fehlen: `berichtly-server --env-file … migrate` |
| `nginx -t` meldet fehlendes Zertifikat | Zertifikat beziehen bzw. Pfad prüfen ([HTTPS.md](HTTPS.md)) |
| Viele `429 RATE_LIMITED` | Limits in `.env` (`RATE_LIMIT_*`) bzw. in `deploy/nginx/snippets/berichtly-http-context.conf` prüfen |
| Geräte erhalten `410 SYNC_CURSOR_EXPIRED` | Normal nach Bereinigung alter Tombstones oder nach `reset-sync-cursors`: Gerät synchronisiert einmal vollständig neu |
