package httpapi_test

import (
	"context"
	"regexp"
	"strings"
	"testing"

	"github.com/google/uuid"

	"berichtly-server/internal/store"
)

func TestHealthCheckOhneSensibleInformationen(t *testing.T) {
	e := newEnv(t)
	r := e.get("/api/v1/health", "").expect(200)
	if r.str("data", "status") != "ok" || r.str("data", "components", "database") != "up" {
		t.Fatal(r.Raw)
	}
	for _, secret := range []string{"postgres", "version", "alpha", "heap", "127.0.0.1"} {
		if strings.Contains(strings.ToLower(r.Raw), secret) {
			t.Fatalf("Health-Check verrät %q: %s", secret, r.Raw)
		}
	}
	if r.Header.Get("X-Request-ID") == "" || r.Header.Get("Cache-Control") != "no-store" ||
		r.Header.Get("X-Content-Type-Options") != "nosniff" || r.Header.Get("Server") != "" {
		t.Fatal(r.Header)
	}
	e.get("/api/v1/health/live", "").expect(200)
}

func TestRequestIDUndUnbekannteEndpunkte(t *testing.T) {
	e := newEnv(t)
	r := e.get("/api/v1/gibt-es-nicht", "", "X-Request-ID", "android-req-12345").expect(404)
	if r.Header.Get("X-Request-ID") != "android-req-12345" || r.code() != "NOT_FOUND" || r.str("error", "requestId") != "android-req-12345" {
		t.Fatal(r.Raw)
	}
	replaced := e.get("/api/v1/health", "", "X-Request-ID", "<script>")
	if !regexp.MustCompile(`^[0-9a-f-]{36}$`).MatchString(replaced.Header.Get("X-Request-ID")) {
		t.Fatal(replaced.Header.Get("X-Request-ID"))
	}
	m := e.do("DELETE", "/api/v1/health", "", nil).expect(405)
	if m.code() != "METHOD_NOT_ALLOWED" {
		t.Fatal(m.Raw)
	}
}

func TestInternerStatusNurMitToken(t *testing.T) {
	e := newEnv(t)
	e.get("/internal/status", "").expect(404)
	e.get("/internal/status", "falsches-token").expect(404)
	r := e.get("/internal/status", statusToken).expect(200)
	if r.str("data", "database", "state") != "UP" || r.num("data", "database", "schemaVersion") != store.LatestSchemaVersion() || r.num("data", "metrics", "requestsTotal") < 1 {
		t.Fatal(r.Raw)
	}

	off := newEnv(t, opts{overrides: map[string]string{"INTERNAL_STATUS_TOKEN": ""}})
	off.get("/internal/status", statusToken).expect(404)
}

func TestAPIDokumentationAbschaltbar(t *testing.T) {
	e := newEnv(t)
	if r := e.get("/api/openapi.yaml", "").expect(200); !strings.Contains(r.Raw, "openapi: 3") {
		t.Fatal(r.Raw)
	}
	e.get("/api/docs", "").expect(200)
	off := newEnv(t, opts{overrides: map[string]string{"API_DOCS_ENABLED": "false"}})
	off.get("/api/openapi.yaml", "").expect(404)
	off.get("/api/docs", "").expect(404)
}

func TestZuGrosseUndFalschTypisierteRequests(t *testing.T) {
	e := newEnv(t, opts{overrides: map[string]string{"MAX_REQUEST_BODY_BYTES": "2048"}})
	tok := e.register("").access
	big := e.post("/api/v1/daily-reports", tok, map[string]any{"date": "2026-10-05", "text": strings.Repeat("x", 5000)}).expect(413)
	if big.code() != "PAYLOAD_TOO_LARGE" {
		t.Fatal(big.Raw)
	}
	r := e.do("POST", "/api/v1/daily-reports", tok, nil, "Content-Type", "text/plain")
	r.expect(415)
}

func TestCORSStandardmaessigAus(t *testing.T) {
	e := newEnv(t)
	if r := e.get("/api/v1/health", "", "Origin", "https://evil.example"); r.Header.Get("Access-Control-Allow-Origin") != "" {
		t.Fatal("CORS ohne Konfiguration aktiv")
	}
	c := newEnv(t, opts{overrides: map[string]string{"CORS_ALLOWED_ORIGINS": "https://app.berichtly.example"}})
	if r := c.get("/api/v1/health", "", "Origin", "https://app.berichtly.example"); r.Header.Get("Access-Control-Allow-Origin") != "https://app.berichtly.example" {
		t.Fatal(r.Header)
	}
	if r := c.get("/api/v1/health", "", "Origin", "https://evil.example"); r.Header.Get("Access-Control-Allow-Origin") != "" {
		t.Fatal("fremde Origin erlaubt")
	}
}

// Datenbank-Integration: Constraints, Trigger und Kaskaden direkt in PostgreSQL.
func TestDatenbankConstraintsUndTrigger(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	pool := e.app.DB.Pool
	user := uuid.New()
	if _, err := pool.Exec(ctx, `INSERT INTO users (id, email, password_hash, timezone) VALUES ($1, 'x@example.org', 'x', 'Europe/Berlin')`, user); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO users (id, email, password_hash, timezone) VALUES ($1, 'x@example.org', 'x', 'Europe/Berlin')`, uuid.New()); err == nil {
		t.Fatal("doppelte E-Mail akzeptiert")
	}
	if _, err := pool.Exec(ctx, `INSERT INTO users (id, email, password_hash, timezone) VALUES ($1, 'Gross@example.org', 'x', 'Europe/Berlin')`, uuid.New()); err == nil {
		t.Fatal("nicht normalisierte E-Mail akzeptiert")
	}
	insertWeek := `INSERT INTO weekly_reports (id, user_id, week_start, week_end, iso_year, iso_week) VALUES ($1, $2, $3::date, $3::date + 6, 2026, 41)`
	if _, err := pool.Exec(ctx, insertWeek, uuid.New(), user, "2026-10-06"); err == nil {
		t.Fatal("Wochenstart ohne Montag akzeptiert")
	}
	if _, err := pool.Exec(ctx, insertWeek, uuid.New(), user, "2026-10-05"); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, insertWeek, uuid.New(), user, "2026-10-05"); err == nil {
		t.Fatal("zweiter aktiver Wochenbericht akzeptiert")
	}

	var a, b int64
	_ = pool.QueryRow(ctx, `INSERT INTO daily_reports (id, user_id, report_date, text) VALUES ($1, $2, '2026-10-05', 'a') RETURNING change_seq`, uuid.New(), user).Scan(&a)
	_ = pool.QueryRow(ctx, `INSERT INTO daily_reports (id, user_id, report_date, text) VALUES ($1, $2, '2026-10-05', 'b') RETURNING change_seq`, uuid.New(), user).Scan(&b)
	if a == 0 || b <= a {
		t.Fatalf("Änderungsnummern nicht monoton: %d, %d", a, b)
	}

	if _, err := pool.Exec(ctx, `DELETE FROM users WHERE id = $1`, user); err != nil {
		t.Fatal(err)
	}
	var remaining int
	_ = pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM daily_reports) + (SELECT count(*) FROM weekly_reports)`).Scan(&remaining)
	if remaining != 0 {
		t.Fatal("Kaskade beim Löschen eines Kontos fehlgeschlagen")
	}

	// Erneutes Migrieren ist ein No-op; die Schema-Version bleibt aktuell.
	if n, err := e.app.DB.Migrate(ctx, e.app.Log); err != nil || n != 0 {
		t.Fatal(n, err)
	}
	if v, _ := e.app.DB.SchemaVersion(ctx); v != store.LatestSchemaVersion() {
		t.Fatal(v)
	}
}
