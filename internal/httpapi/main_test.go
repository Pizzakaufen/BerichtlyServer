package httpapi_test

// Integrationstests gegen eine echte PostgreSQL-Datenbank (keine Mocks). Die Tests laufen über
// echtes HTTP (httptest-Server) durch alle Middleware-Schichten bis in die Datenbank.
//
// Voraussetzung: BERICHTLY_TEST_DATABASE_URL zeigt auf eine LEERE Testdatenbank, deren Name "test"
// enthält (Schutz vor versehentlichem Löschen echter Daten), z. B.
//   postgres://berichtly:passwort@127.0.0.1:5432/berichtly_test
// Am einfachsten:  make test-db && make test

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"berichtly-server/internal/app"
	"berichtly-server/internal/config"
	"berichtly-server/internal/store"
)

const statusToken = "test-status-token-0123456789abcdefghij"

var (
	dbURL     string
	jwtSecret = func() string {
		b := make([]byte, 48)
		_, _ = rand.Read(b)
		return base64.StdEncoding.EncodeToString(b)
	}()
)

func TestMain(m *testing.M) {
	dbURL = os.Getenv("BERICHTLY_TEST_DATABASE_URL")
	if dbURL == "" {
		fmt.Println("BERICHTLY_TEST_DATABASE_URL nicht gesetzt – Integrationstests werden übersprungen (siehe README, 'Tests').")
		os.Exit(0)
	}
	u, err := url.Parse(dbURL)
	if err != nil || !strings.Contains(u.Path, "test") {
		fmt.Println("BERICHTLY_TEST_DATABASE_URL muss auf eine Datenbank zeigen, deren Name 'test' enthält.")
		os.Exit(1)
	}
	if err := resetSchema(); err != nil {
		fmt.Println("Testdatenbank konnte nicht vorbereitet werden:", err)
		os.Exit(1)
	}
	os.Exit(m.Run())
}

// resetSchema leert die Testdatenbank vollständig und führt die echten Migrationen aus.
func resetSchema() error {
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, dbURL)
	if err != nil {
		return err
	}
	if _, err := conn.Exec(ctx, `DROP SCHEMA public CASCADE; CREATE SCHEMA public;`); err != nil {
		return err
	}
	conn.Close(ctx)
	db, err := store.Open(ctx, store.PoolConfig{URL: dbURL, MaxConns: 2, ConnectTimeout: 5 * time.Second})
	if err != nil {
		return err
	}
	defer db.Close()
	_, err = db.Migrate(ctx, slog.New(slog.NewTextHandler(io.Discard, nil)))
	return err
}

func testEnv(overrides map[string]string) map[string]string {
	u, _ := url.Parse(dbURL)
	pw, _ := u.User.Password()
	env := map[string]string{
		"APP_ENV":                    "test",
		"DB_URL":                     dbURL,
		"DB_USER":                    u.User.Username(),
		"DB_PASSWORD":                pw,
		"DB_POOL_MAX_SIZE":           "5",
		"JWT_SECRET":                 jwtSecret,
		"RATE_LIMIT_AUTH_PER_MINUTE": "10000",
		"RATE_LIMIT_API_PER_MINUTE":  "100000",
		"LOGIN_MAX_FAILED_ATTEMPTS":  "5",
		"INTERNAL_STATUS_TOKEN":      statusToken,
		"API_DOCS_ENABLED":           "true",
		"LOG_LEVEL":                  "error",
	}
	for k, v := range overrides {
		env[k] = v
	}
	return env
}

// env ist eine laufende Testinstanz der vollständigen Anwendung.
type env struct {
	t      *testing.T
	app    *app.App
	server *httptest.Server
}

type opts struct {
	overrides map[string]string
	now       func() time.Time
}

func newEnv(t *testing.T, o ...opts) *env {
	t.Helper()
	var opt opts
	if len(o) > 0 {
		opt = o[0]
	}
	if opt.now == nil {
		opt.now = time.Now
	}
	cfg, err := config.Load(testEnv(opt.overrides))
	if err != nil {
		t.Fatal(err)
	}
	a, err := app.New(context.Background(), cfg, slog.New(slog.NewTextHandler(io.Discard, nil)), opt.now)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := a.DB.Pool.Exec(context.Background(), `TRUNCATE users CASCADE`); err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(a.Handler)
	t.Cleanup(func() {
		srv.Close()
		a.DB.Close()
	})
	return &env{t: t, app: a, server: srv}
}

// ---------------------------------------------------------------------------
// HTTP-Hilfen
// ---------------------------------------------------------------------------

type response struct {
	t      *testing.T
	Status int
	Header http.Header
	Raw    string
	Body   any
}

func (e *env) do(method, path, token string, body any, headers ...string) *response {
	e.t.Helper()
	var reader io.Reader
	switch b := body.(type) {
	case nil:
	case string:
		reader = strings.NewReader(b)
	default:
		data, _ := json.Marshal(b)
		reader = bytes.NewReader(data)
	}
	req, _ := http.NewRequest(method, e.server.URL+path, reader)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	for i := 0; i+1 < len(headers); i += 2 {
		req.Header.Set(headers[i], headers[i+1])
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	r := &response{t: e.t, Status: res.StatusCode, Header: res.Header, Raw: string(raw)}
	if len(raw) > 0 && strings.HasPrefix(res.Header.Get("Content-Type"), "application/json") {
		if err := json.Unmarshal(raw, &r.Body); err != nil {
			e.t.Fatalf("ungültiges JSON: %s", raw)
		}
	}
	return r
}

func (e *env) get(path, token string, headers ...string) *response {
	return e.do("GET", path, token, nil, headers...)
}
func (e *env) post(path, token string, body any) *response  { return e.do("POST", path, token, body) }
func (e *env) put(path, token string, body any) *response   { return e.do("PUT", path, token, body) }
func (e *env) patch(path, token string, body any) *response { return e.do("PATCH", path, token, body) }
func (e *env) delete(path, token string) *response          { return e.do("DELETE", path, token, nil) }

// at navigiert durch JSON: at("data", "items", 0, "id").
func (r *response) at(path ...any) any {
	r.t.Helper()
	cur := r.Body
	for _, p := range path {
		switch k := p.(type) {
		case string:
			m, ok := cur.(map[string]any)
			if !ok {
				r.t.Fatalf("kein Objekt bei %v in %s", path, r.Raw)
			}
			v, exists := m[k]
			if !exists {
				r.t.Fatalf("Feld %q fehlt (%v) in %s", k, path, r.Raw)
			}
			cur = v
		case int:
			a, ok := cur.([]any)
			if !ok || k >= len(a) {
				r.t.Fatalf("kein Element %d bei %v in %s", k, path, r.Raw)
			}
			cur = a[k]
		}
	}
	return cur
}

func (r *response) str(path ...any) string { return fmt.Sprint(r.at(path...)) }
func (r *response) num(path ...any) int    { return int(r.at(path...).(float64)) }
func (r *response) list(path ...any) []any { return r.at(path...).([]any) }
func (r *response) code() string           { return r.str("error", "code") }

func (r *response) expect(status int) *response {
	r.t.Helper()
	if r.Status != status {
		r.t.Fatalf("HTTP %d erwartet, %d erhalten: %s", status, r.Status, r.Raw)
	}
	return r
}

func field(v any, key string) any { return v.(map[string]any)[key] }

type session struct {
	access, refresh, userID, sessionID string
}

const defaultPassword = "korrekt-Pferd-Batterie-42"

func (e *env) register(email string, extra ...map[string]any) session {
	e.t.Helper()
	if email == "" {
		email = "user-" + uuid.NewString() + "@example.org"
	}
	body := map[string]any{"email": email, "password": defaultPassword}
	for _, x := range extra {
		for k, v := range x {
			body[k] = v
		}
	}
	return e.post("/api/v1/auth/register", "", body).expect(201).session()
}

func (e *env) login(email, password string) *response {
	return e.post("/api/v1/auth/login", "", map[string]any{"email": email, "password": password})
}

func (r *response) session() session {
	return session{
		access:    r.str("data", "tokens", "accessToken"),
		refresh:   r.str("data", "tokens", "refreshToken"),
		userID:    r.str("data", "account", "id"),
		sessionID: r.str("data", "tokens", "sessionId"),
	}
}

func fields(details any) []string {
	var out []string
	for _, d := range details.([]any) {
		out = append(out, field(d, "field").(string))
	}
	return out
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}
