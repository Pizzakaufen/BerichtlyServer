package httpapi_test

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"berichtly-server/internal/app"
	"berichtly-server/internal/config"
	"berichtly-server/internal/security"
	"berichtly-server/internal/store"
)

// tempDatabase legt eine eigene, leere Datenbank für einen Test an und löscht sie danach wieder.
func tempDatabase(t *testing.T) string {
	t.Helper()
	ctx := context.Background()
	admin, err := pgx.Connect(ctx, dbURL)
	if err != nil {
		t.Fatal(err)
	}
	name := "berichtly_upgrade_test_" + strings.ReplaceAll(uuid.NewString()[:8], "-", "")
	if _, err := admin.Exec(ctx, "CREATE DATABASE "+pgx.Identifier{name}.Sanitize()); err != nil {
		t.Skip("Testbenutzer darf keine Datenbanken anlegen (CREATEDB fehlt):", err)
	}
	admin.Close(ctx)
	u, _ := url.Parse(dbURL)
	u.Path = "/" + name
	t.Cleanup(func() {
		c, err := pgx.Connect(ctx, dbURL)
		if err == nil {
			_, _ = c.Exec(ctx, "DROP DATABASE IF EXISTS "+pgx.Identifier{name}.Sanitize()+" WITH (FORCE)")
			c.Close(ctx)
		}
	})
	return u.String()
}

func TestUpgradeVon10AlphaAuf11OhneDatenverlust(t *testing.T) {
	ctx := context.Background()
	quiet := slog.New(slog.NewTextHandler(io.Discard, nil))
	dbu := tempDatabase(t)
	db, err := store.Open(ctx, store.PoolConfig{URL: dbu, MaxConns: 3, ConnectTimeout: 5 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// 1. Installation von Berichtly Server 1.0 Alpha (nur Migration 0001) …
	if n, err := db.MigrateTo(ctx, quiet, 1); err != nil || n != 1 {
		t.Fatal(n, err)
	}
	// … mit realistischen Bestandsdaten, wie 1.0 sie geschrieben hat.
	hash, _ := security.NewPasswordHasher().Hash(ctx, defaultPassword)
	users := []uuid.UUID{uuid.New(), uuid.New()}
	device := uuid.New()
	deviceRef := uuid.New()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := db.Pool.Exec(ctx, sql, args...); err != nil {
			t.Fatal(sql, err)
		}
	}
	for i, u := range users {
		exec(`INSERT INTO users (id, email, password_hash, timezone) VALUES ($1, $2, $3, 'Europe/Berlin')`,
			u, fmt.Sprintf("bestand%d@example.org", i), hash)
		exec(`INSERT INTO user_profiles (user_id, name, profession, company, training_start, writing_style)
			VALUES ($1, $2, 'Fachinformatiker', 'Muster GmbH', '2025-08-01', 'FORMAL')`, u, fmt.Sprintf("Azubi %d", i))
	}
	exec(`INSERT INTO devices (id, user_id, device_id, name, last_pull_at, last_pull_cursor) VALUES ($1, $2, $3, 'Pixel', now(), 5)`,
		deviceRef, users[0], device)
	exec(`INSERT INTO sessions (id, user_id, device_ref, expires_at) VALUES ($1, $2, $3, now() + interval '30 days')`,
		uuid.New(), users[0], deviceRef)
	dailyIDs := make([]uuid.UUID, 0)
	for i := 0; i < 300; i++ {
		id := uuid.New()
		dailyIDs = append(dailyIDs, id)
		exec(`INSERT INTO daily_reports (id, user_id, report_date, text, note, order_index, status, version, last_device_ref)
			VALUES ($1, $2, DATE '2026-01-05' + $3::int, $4, 'Notiz', $5, 'EDITED', 2, $6)`,
			id, users[i%2], i/3, fmt.Sprintf("Tätigkeit %d mit Umlauten äöüß", i), i%3, deviceRef)
	}
	exec(`UPDATE daily_reports SET deleted_at = now(), text = '', note = '' WHERE id = $1`, dailyIDs[0]) // Tombstone
	exec(`INSERT INTO weekly_reports (id, user_id, week_start, week_end, iso_year, iso_week, content, status, generated_at)
		VALUES ($1, $2, '2026-01-05', '2026-01-11', 2026, 2, 'Wochenbericht KW 2', 'FINALIZED', now())`, uuid.New(), users[0])

	fingerprint := func() string {
		var fp string
		if err := db.Pool.QueryRow(ctx, `SELECT md5(string_agg(x, '|' ORDER BY x)) FROM (
			SELECT concat_ws(',', id, user_id, report_date, text, note, order_index, status, version, created_at, deleted_at, change_seq) x FROM daily_reports
			UNION ALL SELECT concat_ws(',', id, user_id, week_start, content, status, version, generated_at, change_seq) FROM weekly_reports
			UNION ALL SELECT concat_ws(',', user_id, name, profession, company, training_start, writing_style, version) FROM user_profiles
			UNION ALL SELECT concat_ws(',', id, email, password_hash, timezone, created_at) FROM users
			UNION ALL SELECT concat_ws(',', id, user_id, device_id, name, last_pull_cursor) FROM devices
			UNION ALL SELECT concat_ws(',', id, user_id, device_ref, expires_at) FROM sessions) t`).Scan(&fp); err != nil {
			t.Fatal(err)
		}
		return fp
	}
	before := fingerprint()

	// 2. Upgrade auf 1.1.
	if n, err := db.Migrate(ctx, quiet); err != nil || n != store.LatestSchemaVersion()-1 {
		t.Fatal(n, err)
	}
	if after := fingerprint(); after != before {
		t.Fatal("Bestandsdaten wurden durch die Migration verändert")
	}
	var status string
	var cursor *int64
	_ = db.Pool.QueryRow(ctx, `SELECT sync_status, last_pull_cursor FROM devices WHERE id = $1`, deviceRef).Scan(&status, &cursor)
	if status != "NEVER" || cursor == nil || *cursor != 5 {
		t.Fatal("Gerätedaten nach Upgrade falsch:", status, cursor)
	}

	// 3. Die aktualisierte Installation ist über die API voll nutzbar.
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

	s := e.loginDevice("bestand0@example.org", device.String(), "Pixel")
	if e.get("/api/v1/daily-reports?limit=1", s.access).num("meta", "total") != 149 { // 150 minus Tombstone
		t.Fatal("Berichte nach Upgrade nicht vollständig")
	}
	if e.get("/api/v1/profile", s.access).str("data", "name") != "Azubi 0" {
		t.Fatal("Profil nach Upgrade falsch")
	}
	if e.get("/api/v1/devices?includeRevoked=true", s.access).num("meta", "total") != 1 {
		t.Fatal("Gerät aus 1.0 wurde dupliziert statt wiederverwendet")
	}
	full := e.get("/api/v1/sync/changes?cursor=0&limit=500", s.access).expect(200)
	if n := len(full.list("data", "changes")); n != 150+1+1 { // Tagesberichte (inkl. Tombstone) + Woche + Profil
		t.Fatalf("%d Änderungen nach Upgrade", n)
	}
	// Bestehender Bericht (Version 2 aus 1.0) lässt sich mit Versionsprüfung ändern.
	id := dailyIDs[2] // gehört users[0]
	upd := e.put("/api/v1/daily-reports/"+id.String(), s.access, map[string]any{"version": 2, "date": "2026-01-05", "text": "Nach Upgrade geändert"}).expect(200)
	if upd.num("data", "version") != 3 {
		t.Fatal(upd.Raw)
	}
	e.get("/api/v1/daily-reports/"+dailyIDs[1].String(), s.access).expect(404) // gehört users[1]

	// 4. Nachträglich veränderte Migration wird erkannt und blockiert.
	exec(`UPDATE schema_migrations SET checksum = 'manipuliert' WHERE version = 1`)
	states, _ := db.MigrationStatus(ctx)
	if states[0].State != "modified" {
		t.Fatal(states)
	}
	if _, err := db.Migrate(ctx, quiet); err == nil || !strings.Contains(err.Error(), "verändert") {
		t.Fatal("veränderte Migration nicht erkannt:", err)
	}
}
