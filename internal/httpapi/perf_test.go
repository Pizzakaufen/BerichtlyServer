package httpapi_test

import (
	"context"
	"io"
	"log/slog"
	"net/http/httptest"
	"net/url"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"berichtly-server/internal/app"
	"berichtly-server/internal/config"
	"berichtly-server/internal/security"
	"berichtly-server/internal/store"
)

// Leistungstest mit großen Datenmengen (nur mit BERICHTLY_PERF_TEST=1, dauert ca. 1 Minute):
// 200 000 Tagesberichte für ein Konto plus 100 000 für andere Konten. Geprüft wird, dass die
// häufigen Abfragen Indizes nutzen (keine Full-Table-Scans) und in vertretbarer Zeit antworten.
func TestLeistungMitVielenBerichten(t *testing.T) {
	if os.Getenv("BERICHTLY_PERF_TEST") != "1" {
		t.Skip("nur mit BERICHTLY_PERF_TEST=1")
	}
	ctx := context.Background()
	quiet := slog.New(slog.NewTextHandler(io.Discard, nil))
	dbu := tempDatabase(t)
	db, err := store.Open(ctx, store.PoolConfig{URL: dbu, MaxConns: 3, ConnectTimeout: 5 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Migrate(ctx, quiet); err != nil {
		t.Fatal(err)
	}
	hash, _ := security.NewPasswordHasher().Hash(ctx, defaultPassword)
	main := uuid.New()
	start := time.Now()
	for _, sql := range []string{
		`INSERT INTO users (id, email, password_hash, timezone) VALUES ('` + main.String() + `', 'viel@example.org', '` + hash + `', 'Europe/Berlin')`,
		`INSERT INTO user_profiles (user_id) VALUES ('` + main.String() + `')`,
		`INSERT INTO users (id, email, password_hash, timezone)
			SELECT gen_random_uuid(), 'u' || g || '@example.org', 'x', 'Europe/Berlin' FROM generate_series(1, 100) g`,
		// 200 000 Berichte für das Hauptkonto (ca. 27 Jahre zu je 20 Tätigkeiten pro Tag), 5 % gelöscht.
		`INSERT INTO daily_reports (id, user_id, report_date, text, status, deleted_at)
			SELECT gen_random_uuid(), '` + main.String() + `', DATE '2000-01-01' + (g / 20), 'Tätigkeit ' || g,
			       (ARRAY['DRAFT','GENERATED','EDITED','FINALIZED'])[1 + g % 4],
			       CASE WHEN g % 20 = 0 THEN now() END
			FROM generate_series(1, 200000) g`,
		// 100 000 Berichte verteilt auf 100 andere Konten.
		`INSERT INTO daily_reports (id, user_id, report_date, text)
			SELECT gen_random_uuid(), u.id, DATE '2020-01-01' + (g % 2000), 'x'
			FROM (SELECT id, row_number() OVER () n FROM users WHERE email LIKE 'u%') u
			JOIN generate_series(1, 100000) g ON g % 100 = u.n - 1`,
		`ANALYZE`,
	} {
		if _, err := db.Pool.Exec(ctx, sql); err != nil {
			t.Fatal(err)
		}
	}
	t.Logf("Testdaten angelegt in %s", time.Since(start).Round(time.Millisecond))

	// Ausführungspläne: Die Sync- und Listenabfragen dürfen daily_reports nicht vollständig durchsuchen.
	for name, sql := range map[string]string{
		"Sync-Abruf":      `SELECT id FROM daily_reports WHERE user_id = $1 AND change_seq > $2 ORDER BY change_seq LIMIT 501`,
		"Wochenübersicht": `SELECT id FROM daily_reports WHERE user_id = $1 AND deleted_at IS NULL AND report_date BETWEEN '2010-01-04' AND '2010-01-10'`,
		"Liste Monat":     `SELECT id FROM daily_reports WHERE user_id = $1 AND deleted_at IS NULL AND report_date >= '2010-03-01' AND report_date <= '2010-03-31' ORDER BY report_date DESC LIMIT 50`,
	} {
		rows, err := db.Pool.Query(ctx, "EXPLAIN "+sql, main, int64(150000))
		if name != "Sync-Abruf" {
			rows, err = db.Pool.Query(ctx, "EXPLAIN "+sql, main)
		}
		if err != nil {
			t.Fatal(err)
		}
		var plan []string
		for rows.Next() {
			var line string
			_ = rows.Scan(&line)
			plan = append(plan, line)
		}
		rows.Close()
		joined := strings.Join(plan, "\n")
		if strings.Contains(joined, "Seq Scan on daily_reports") {
			t.Fatalf("%s nutzt keinen Index:\n%s", name, joined)
		}
	}

	u, _ := url.Parse(dbu)
	pw, _ := u.User.Password()
	cfg, err := config.Load(testEnv(map[string]string{"DB_URL": dbu, "DB_USER": u.User.Username(), "DB_PASSWORD": pw}))
	if err != nil {
		t.Fatal(err)
	}
	a, err := app.New(ctx, cfg, quiet, time.Now)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(a.Handler)
	defer srv.Close()
	defer a.DB.Close()
	e := &env{t: t, app: a, server: srv}
	s := e.post("/api/v1/auth/login", "", map[string]any{"email": "viel@example.org", "password": defaultPassword}).expect(200).session()

	var mid int64
	_ = db.Pool.QueryRow(ctx, `SELECT change_seq FROM daily_reports WHERE user_id = $1 ORDER BY change_seq OFFSET 150000 LIMIT 1`, main).Scan(&mid)
	measure := func(name, path string) {
		t.Helper()
		best := time.Hour
		for i := 0; i < 3; i++ {
			t0 := time.Now()
			e.get(path, s.access).expect(200)
			best = min(best, time.Since(t0))
		}
		t.Logf("%-38s %8s", name, best.Round(100*time.Microsecond))
		if best > 2*time.Second {
			t.Fatalf("%s zu langsam: %s", name, best)
		}
	}
	measure("Sync: erste Seite (500 Änderungen)", "/api/v1/sync/changes?cursor=0&limit=500")
	measure("Sync: Seite ab Cursor (Mitte)", "/api/v1/sync/changes?limit=500&cursor="+itoa64(mid))
	measure("Sync: Status", "/api/v1/sync/status")
	measure("Liste: Seite 1 (50)", "/api/v1/daily-reports?limit=50")
	measure("Liste: Monat März 2010", "/api/v1/daily-reports?year=2010&month=3&limit=50")
	measure("Liste: Status-Filter", "/api/v1/daily-reports?status=FINALIZED&limit=50")
	measure("Liste: tiefe Seite (Seite 3000)", "/api/v1/daily-reports?limit=50&page=3000")
	measure("Wochenübersicht", "/api/v1/weeks/2010-01-06")
}

func itoa64(n int64) string { return strconv.FormatInt(n, 10) }
