package httpapi_test

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"

	"berichtly-server/internal/security"
)

func TestRegistrierungSpeichertNurArgon2Hash(t *testing.T) {
	e := newEnv(t)
	r := e.post("/api/v1/auth/register", "", map[string]any{
		"email": "  Anna.Muster@Example.ORG ", "password": defaultPassword,
	}).expect(201)
	if got := r.str("data", "account", "email"); got != "anna.muster@example.org" {
		t.Fatalf("E-Mail nicht normalisiert: %s", got)
	}
	if r.str("data", "account", "timezone") != "Europe/Berlin" || r.str("data", "tokens", "tokenType") != "Bearer" {
		t.Fatal(r.Raw)
	}
	refresh := r.str("data", "tokens", "refreshToken")
	if !strings.HasPrefix(refresh, "brt_") {
		t.Fatal("Refresh Token ohne Präfix")
	}

	var hash string
	ctx := context.Background()
	if err := e.app.DB.Pool.QueryRow(ctx, `SELECT password_hash FROM users WHERE email = $1`, "anna.muster@example.org").Scan(&hash); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(hash, "$argon2id$v=19$") || strings.Contains(hash, defaultPassword) {
		t.Fatalf("Passwort nicht sicher gespeichert: %s", hash)
	}
	var plain int
	_ = e.app.DB.Pool.QueryRow(ctx, `SELECT count(*) FROM refresh_tokens WHERE position($1::bytea IN token_hash) > 0`,
		[]byte(refresh)).Scan(&plain)
	if plain != 0 {
		t.Fatal("Refresh Token im Klartext gespeichert")
	}
}

func TestDoppelteEmailWirdAbgelehnt(t *testing.T) {
	e := newEnv(t)
	e.register("doppelt@example.org")
	r := e.post("/api/v1/auth/register", "", map[string]any{"email": "DOPPELT@example.org", "password": defaultPassword}).expect(409)
	if r.code() != "EMAIL_ALREADY_REGISTERED" {
		t.Fatal(r.Raw)
	}
}

func TestUngueltigeRegistrierungsdaten(t *testing.T) {
	e := newEnv(t)
	r := e.post("/api/v1/auth/register", "", map[string]any{
		"email": "keine-mail", "password": "kurz", "timezone": "Mars/Olympus",
	}).expect(422)
	got := fields(r.at("error", "details"))
	for _, f := range []string{"email", "password", "timezone"} {
		if !contains(got, f) {
			t.Fatalf("Fehler für %s fehlt: %v", f, got)
		}
	}
	e.post("/api/v1/auth/register", "", map[string]any{}).expect(422)
	e.post("/api/v1/auth/register", "", map[string]any{"email": "gleich@example.org", "password": "gleich@example.org"}).expect(422)
}

func TestUngueltigesJSONOhneInterneDetails(t *testing.T) {
	e := newEnv(t)
	r := e.do("POST", "/api/v1/auth/login", "", `{"email": `).expect(400)
	if r.code() != "INVALID_REQUEST_BODY" || strings.Contains(r.Raw, "json:") || strings.Contains(r.Raw, "unexpected") {
		t.Fatal(r.Raw)
	}
	r = e.do("POST", "/api/v1/auth/login", "", `{"email": 5}`).expect(400)
	if r.code() != "INVALID_REQUEST_BODY" {
		t.Fatal(r.Raw)
	}
}

func TestLoginGleicherFehlerFuerFalschesPasswortUndUnbekannteEmail(t *testing.T) {
	e := newEnv(t)
	e.register("login@example.org")
	e.login("login@example.org", defaultPassword).expect(200)
	if r := e.login("login@example.org", "falsches-Passwort-123").expect(401); r.code() != "INVALID_CREDENTIALS" {
		t.Fatal(r.Raw)
	}
	if r := e.login("niemand@example.org", defaultPassword).expect(401); r.code() != "INVALID_CREDENTIALS" {
		t.Fatal(r.Raw)
	}
}

func TestKontosperreNachFehlversuchen(t *testing.T) {
	e := newEnv(t)
	e.register("brute@example.org")
	for i := 0; i < 5; i++ {
		e.login("brute@example.org", "falsch-falsch-123").expect(401)
	}
	if r := e.login("brute@example.org", defaultPassword).expect(429); r.code() != "ACCOUNT_TEMPORARILY_LOCKED" {
		t.Fatal(r.Raw)
	}
}

func TestRateLimitFuerAuthEndpunkte(t *testing.T) {
	e := newEnv(t, opts{overrides: map[string]string{"RATE_LIMIT_AUTH_PER_MINUTE": "3"}})
	for i := 0; i < 3; i++ {
		e.login("limit@example.org", defaultPassword)
	}
	r := e.login("limit@example.org", defaultPassword).expect(429)
	if r.code() != "RATE_LIMITED" || r.Header.Get("Retry-After") == "" {
		t.Fatal(r.Raw)
	}
	e.get("/api/v1/health", "").expect(200) // andere Endpunkte sind nicht betroffen
}

func TestRegistrierungAbschaltbar(t *testing.T) {
	e := newEnv(t, opts{overrides: map[string]string{"REGISTRATION_ENABLED": "false"}})
	r := e.post("/api/v1/auth/register", "", map[string]any{"email": "neu@example.org", "password": defaultPassword}).expect(403)
	if r.code() != "REGISTRATION_DISABLED" {
		t.Fatal(r.Raw)
	}
}

func TestRefreshRotiertUndErkenntWiederverwendung(t *testing.T) {
	e := newEnv(t)
	s := e.register("")
	rotated := e.post("/api/v1/auth/refresh", "", map[string]any{"refreshToken": s.refresh}).expect(200).session()
	if rotated.refresh == s.refresh || rotated.sessionID != s.sessionID {
		t.Fatal("Refresh Token wurde nicht rotiert")
	}
	e.get("/api/v1/account", rotated.access).expect(200)

	// Altes Token erneut verwenden → Sitzung wird vollständig widerrufen.
	if r := e.post("/api/v1/auth/refresh", "", map[string]any{"refreshToken": s.refresh}).expect(401); r.code() != "INVALID_REFRESH_TOKEN" {
		t.Fatal(r.Raw)
	}
	e.post("/api/v1/auth/refresh", "", map[string]any{"refreshToken": rotated.refresh}).expect(401)
	e.get("/api/v1/account", rotated.access).expect(401)
}

func TestUngueltigeRefreshTokens(t *testing.T) {
	e := newEnv(t)
	e.post("/api/v1/auth/refresh", "", map[string]any{}).expect(422)
	e.post("/api/v1/auth/refresh", "", map[string]any{"refreshToken": "abc"}).expect(401)
	e.post("/api/v1/auth/refresh", "", map[string]any{"refreshToken": "brt_" + strings.Repeat("A", 43)}).expect(401)
}

func TestLogoutWiderruftTokensSofort(t *testing.T) {
	e := newEnv(t)
	s := e.register("")
	e.post("/api/v1/auth/logout", s.access, nil).expect(204)
	e.get("/api/v1/profile", s.access).expect(401)
	e.post("/api/v1/auth/refresh", "", map[string]any{"refreshToken": s.refresh}).expect(401)
}

func TestFehlendeUngueltigeFremdeUndAbgelaufeneTokens(t *testing.T) {
	e := newEnv(t)
	s := e.register("")

	r := e.get("/api/v1/daily-reports", "").expect(401)
	if r.code() != "UNAUTHORIZED" || r.Header.Get("WWW-Authenticate") == "" {
		t.Fatal(r.Raw)
	}
	e.get("/api/v1/daily-reports", "kein.jwt.token").expect(401)

	// Fremd signiert
	forged, _ := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"iss": "berichtly-server", "aud": "berichtly-app", "sub": s.userID, "sid": s.sessionID,
		"iat": time.Now().Unix(), "exp": time.Now().Add(10 * time.Minute).Unix(),
	}).SignedString([]byte("ein-anderes-geheimnis-mit-ausreichender-laenge-123"))
	e.get("/api/v1/daily-reports", forged).expect(401)

	// Algorithmus "none" wird nie akzeptiert
	none, _ := jwt.NewWithClaims(jwt.SigningMethodNone, jwt.MapClaims{
		"iss": "berichtly-server", "aud": "berichtly-app", "sub": s.userID, "sid": s.sessionID,
		"exp": time.Now().Add(10 * time.Minute).Unix(),
	}).SignedString(jwt.UnsafeAllowNoneSignatureType)
	e.get("/api/v1/daily-reports", none).expect(401)

	// Abgelaufen (mit 2 Stunden alter Uhr ausgestellt)
	cfg := e.app.Cfg.Auth
	past := security.NewTokens(cfg.JWTSecret, cfg.Issuer, cfg.Audience, cfg.AccessTokenTTL,
		func() time.Time { return time.Now().Add(-2 * time.Hour) })
	expired, _, _ := past.IssueAccessToken(uuid.MustParse(s.userID), uuid.MustParse(s.sessionID))
	e.get("/api/v1/daily-reports", expired).expect(401)

	// Gültige Signatur, aber unbekannte Sitzung
	unknown, _, _ := e.app.Auth.Tokens.IssueAccessToken(uuid.MustParse(s.userID), uuid.New())
	e.get("/api/v1/daily-reports", unknown).expect(401)

	e.get("/api/v1/daily-reports", s.access).expect(200)
}

func TestKontoZeitzoneAendern(t *testing.T) {
	e := newEnv(t)
	s := e.register("")
	if r := e.patch("/api/v1/account", s.access, map[string]any{"timezone": "Europe/Vienna"}).expect(200); r.str("data", "timezone") != "Europe/Vienna" {
		t.Fatal(r.Raw)
	}
	e.patch("/api/v1/account", s.access, map[string]any{"timezone": "UTC+2"}).expect(422)
}
