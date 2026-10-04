// Package config lädt die Konfiguration ausschließlich aus Umgebungsvariablen (optional ergänzt
// um eine .env-Datei). Secrets haben bewusst keine Standardwerte: Fehlen sie, startet der Server nicht.
package config

import (
	"bufio"
	"encoding/base64"
	"fmt"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
)

type Environment string

const (
	Development Environment = "development"
	Test        Environment = "test"
	Production  Environment = "production"
)

type Config struct {
	Env       Environment
	Server    Server
	Database  Database
	Auth      Auth
	RateLimit RateLimit
	CORS      CORS
	Log       Log
	APIDocs   bool
	Status    Status
}

type Server struct {
	Host string
	Port int
	// Nur aktivieren, wenn der Server ausschließlich hinter einem Reverse Proxy erreichbar ist.
	TrustProxy      bool
	ShutdownTimeout time.Duration
	MaxBodyBytes    int64
}

type Database struct {
	URL            string
	MaxConns       int32
	MinConns       int32
	ConnectTimeout time.Duration
	MigrateOnStart bool
	// Nur für die Anzeige (ohne Passwort).
	Display string
}

type Auth struct {
	JWTSecret           []byte
	Issuer              string
	Audience            string
	AccessTokenTTL      time.Duration
	RefreshTokenTTL     time.Duration
	SessionMaxLifetime  time.Duration
	RegistrationEnabled bool
	MaxFailedLogins     int
	LockoutDuration     time.Duration
	DefaultTimezone     string
}

type RateLimit struct {
	AuthPerMinute int // Login, Registrierung, Token-Erneuerung pro Client-IP
	APIPerMinute  int // alle übrigen Endpunkte pro Client-IP
}

type CORS struct {
	AllowedOrigins []string
}

type Log struct {
	Level  string // debug | info | warn | error
	Format string // text | json
}

type Status struct {
	InternalToken string // leer = interner Statusbereich deaktiviert
	MinFreeDiskMB int64
}

func (c *Config) IsProduction() bool { return c.Env == Production }

// Summary beschreibt die Konfiguration ohne Secrets (für `check-config`).
func (c *Config) Summary() string {
	status := "<deaktiviert>"
	if c.Status.InternalToken != "" {
		status = "aktiviert (Token gesetzt)"
	}
	origins := "<deaktiviert>"
	if len(c.CORS.AllowedOrigins) > 0 {
		origins = strings.Join(c.CORS.AllowedOrigins, ", ")
	}
	docs := "deaktiviert"
	if c.APIDocs {
		docs = "aktiviert (/api/docs)"
	}
	return fmt.Sprintf(`Umgebung:   %s
Server:     %s:%d (trustProxy=%t, maxBody=%d Byte)
Datenbank:  %s (Pool max=%d, min=%d, migrateOnStart=%t)
Auth:       Access Token %s, Refresh Token %s, Sitzung max. %s, Registrierung=%t, JWT_SECRET=***
Rate Limit: Auth %d/min, API %d/min pro IP
CORS:       %s
Logging:    %s / %s
API-Doku:   %s
Status:     %s`,
		c.Env, c.Server.Host, c.Server.Port, c.Server.TrustProxy, c.Server.MaxBodyBytes,
		c.Database.Display, c.Database.MaxConns, c.Database.MinConns, c.Database.MigrateOnStart,
		c.Auth.AccessTokenTTL, c.Auth.RefreshTokenTTL, c.Auth.SessionMaxLifetime, c.Auth.RegistrationEnabled,
		c.RateLimit.AuthPerMinute, c.RateLimit.APIPerMinute, origins, c.Log.Level, c.Log.Format, docs, status)
}

// Load liest die Konfiguration aus env (z. B. EnvMap(os.Environ())).
func Load(env map[string]string) (*Config, error) {
	r := reader{env: env}
	c := &Config{}

	switch strings.ToLower(r.str("APP_ENV", "production")) {
	case "development", "dev":
		c.Env = Development
	case "test":
		c.Env = Test
	case "production", "prod":
		c.Env = Production
	default:
		r.fail("APP_ENV muss 'development', 'test' oder 'production' sein")
	}
	prod := c.Env == Production

	c.Server = Server{
		Host:            r.str("SERVER_HOST", "127.0.0.1"),
		Port:            r.integer("SERVER_PORT", 8080, 1, 65535),
		TrustProxy:      r.boolean("TRUST_PROXY", false),
		ShutdownTimeout: time.Duration(r.integer("SHUTDOWN_TIMEOUT_SECONDS", 15, 1, 300)) * time.Second,
		MaxBodyBytes:    int64(r.integer("MAX_REQUEST_BODY_BYTES", 1<<20, 1024, 50<<20)),
	}

	c.Database = Database{
		MaxConns:       int32(r.integer("DB_POOL_MAX_SIZE", 10, 1, 200)),
		MinConns:       int32(r.integer("DB_POOL_MIN_IDLE", 0, 0, 200)),
		ConnectTimeout: time.Duration(r.integer("DB_CONNECT_TIMEOUT_SECONDS", 5, 1, 60)) * time.Second,
		MigrateOnStart: r.boolean("DB_MIGRATE_ON_START", true),
	}
	if c.Database.MinConns > c.Database.MaxConns {
		r.fail("DB_POOL_MIN_IDLE darf nicht größer als DB_POOL_MAX_SIZE sein")
	}
	c.Database.URL, c.Database.Display = r.databaseURL()

	c.Auth = Auth{
		JWTSecret:           r.secret("JWT_SECRET"),
		Issuer:              r.str("JWT_ISSUER", "berichtly-server"),
		Audience:            r.str("JWT_AUDIENCE", "berichtly-app"),
		AccessTokenTTL:      time.Duration(r.integer("ACCESS_TOKEN_TTL_MINUTES", 15, 1, 60)) * time.Minute,
		RefreshTokenTTL:     time.Duration(r.integer("REFRESH_TOKEN_TTL_DAYS", 30, 1, 90)) * 24 * time.Hour,
		SessionMaxLifetime:  time.Duration(r.integer("SESSION_MAX_LIFETIME_DAYS", 180, 1, 365)) * 24 * time.Hour,
		RegistrationEnabled: r.boolean("REGISTRATION_ENABLED", true),
		MaxFailedLogins:     r.integer("LOGIN_MAX_FAILED_ATTEMPTS", 10, 3, 100),
		LockoutDuration:     time.Duration(r.integer("LOGIN_LOCKOUT_MINUTES", 15, 1, 1440)) * time.Minute,
		DefaultTimezone:     r.str("DEFAULT_TIMEZONE", "Europe/Berlin"),
	}
	if _, err := time.LoadLocation(c.Auth.DefaultTimezone); err != nil || !strings.Contains(c.Auth.DefaultTimezone, "/") {
		r.fail("DEFAULT_TIMEZONE ist keine gültige Zeitzone (z. B. Europe/Berlin)")
	}

	c.RateLimit = RateLimit{
		AuthPerMinute: r.integer("RATE_LIMIT_AUTH_PER_MINUTE", 10, 1, 10000),
		APIPerMinute:  r.integer("RATE_LIMIT_API_PER_MINUTE", 300, 1, 100000),
	}

	originPattern := regexp.MustCompile(`^https?://[A-Za-z0-9.-]+(:\d{1,5})?$`)
	for _, o := range strings.Split(r.str("CORS_ALLOWED_ORIGINS", ""), ",") {
		o = strings.TrimSpace(o)
		switch {
		case o == "":
			continue
		case o == "*":
			if prod {
				r.fail("CORS_ALLOWED_ORIGINS darf in Produktion nicht '*' enthalten")
			}
		case !originPattern.MatchString(o):
			r.fail(fmt.Sprintf("ungültige Origin in CORS_ALLOWED_ORIGINS: %q (erwartet z. B. https://app.example.de)", o))
		}
		c.CORS.AllowedOrigins = append(c.CORS.AllowedOrigins, o)
	}

	defLevel, defFormat := "debug", "text"
	if prod {
		defLevel, defFormat = "info", "json"
	}
	c.Log.Level = strings.ToLower(r.str("LOG_LEVEL", defLevel))
	if !oneOf(c.Log.Level, "debug", "info", "warn", "error") {
		r.fail("LOG_LEVEL muss debug, info, warn oder error sein")
	}
	c.Log.Format = strings.ToLower(r.str("LOG_FORMAT", defFormat))
	if !oneOf(c.Log.Format, "text", "json") {
		r.fail("LOG_FORMAT muss 'text' oder 'json' sein")
	}

	c.APIDocs = r.boolean("API_DOCS_ENABLED", !prod)

	c.Status.InternalToken = r.str("INTERNAL_STATUS_TOKEN", "")
	if c.Status.InternalToken != "" && len(c.Status.InternalToken) < 32 {
		r.fail("INTERNAL_STATUS_TOKEN muss mindestens 32 Zeichen lang sein")
	}
	c.Status.MinFreeDiskMB = int64(r.integer("STATUS_MIN_FREE_DISK_MB", 512, 0, 10_000_000))

	if len(r.errs) > 0 {
		return nil, fmt.Errorf("Konfigurationsfehler:\n  - %s", strings.Join(r.errs, "\n  - "))
	}
	return c, nil
}

// EnvMap wandelt os.Environ() in eine Map um.
func EnvMap(environ []string) map[string]string {
	m := make(map[string]string, len(environ))
	for _, kv := range environ {
		if k, v, ok := strings.Cut(kv, "="); ok {
			m[k] = v
		}
	}
	return m
}

// MergeEnvFile liest eine einfache .env-Datei (KEY=VALUE, # für Kommentare). Werte aus der echten
// Umgebung haben immer Vorrang.
func MergeEnvFile(path string, env map[string]string) (map[string]string, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("Konfigurationsdatei kann nicht gelesen werden: %w", err)
	}
	defer f.Close()
	merged := map[string]string{}
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		k, v, ok := strings.Cut(strings.TrimPrefix(line, "export "), "=")
		if !ok || strings.TrimSpace(k) == "" {
			continue
		}
		v = strings.TrimSpace(v)
		if len(v) >= 2 && (v[0] == '"' && v[len(v)-1] == '"' || v[0] == '\'' && v[len(v)-1] == '\'') {
			v = v[1 : len(v)-1]
		}
		merged[strings.TrimSpace(k)] = v
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	for k, v := range env {
		merged[k] = v
	}
	return merged, nil
}

type reader struct {
	env  map[string]string
	errs []string
}

func (r *reader) fail(msg string) { r.errs = append(r.errs, msg) }

func (r *reader) optional(key string) string { return strings.TrimSpace(r.env[key]) }

func (r *reader) str(key, def string) string {
	if v := r.optional(key); v != "" {
		return v
	}
	return def
}

func (r *reader) required(key string) string {
	v := r.optional(key)
	if v == "" {
		r.fail("Umgebungsvariable " + key + " fehlt")
	}
	return v
}

func (r *reader) integer(key string, def, min, max int) int {
	raw := r.optional(key)
	if raw == "" {
		return def
	}
	v, err := strconv.Atoi(raw)
	if err != nil {
		r.fail(key + " muss eine ganze Zahl sein")
		return def
	}
	if v < min || v > max {
		r.fail(fmt.Sprintf("%s muss zwischen %d und %d liegen", key, min, max))
		return def
	}
	return v
}

func (r *reader) boolean(key string, def bool) bool {
	switch strings.ToLower(r.optional(key)) {
	case "":
		return def
	case "true", "1", "yes":
		return true
	case "false", "0", "no":
		return false
	default:
		r.fail(key + " muss 'true' oder 'false' sein")
		return def
	}
}

func (r *reader) secret(key string) []byte {
	raw := r.required(key)
	if raw == "" {
		return nil
	}
	b, err := base64.StdEncoding.DecodeString(raw)
	if err != nil {
		r.fail(key + " muss Base64-kodiert sein (z. B. 'openssl rand -base64 48')")
		return nil
	}
	if len(b) < 32 {
		r.fail(key + " muss mindestens 32 Byte Zufallsdaten enthalten")
		return nil
	}
	distinct := map[byte]struct{}{}
	for _, x := range b {
		distinct[x] = struct{}{}
	}
	if len(distinct) < 8 {
		r.fail(key + " ist offensichtlich nicht zufällig")
		return nil
	}
	return b
}

// databaseURL baut die Verbindungs-URL aus DB_* oder übernimmt DB_URL.
func (r *reader) databaseURL() (full, display string) {
	user := r.required("DB_USER")
	password := r.required("DB_PASSWORD")
	if raw := r.optional("DB_URL"); raw != "" {
		u, err := url.Parse(raw)
		if err != nil || (u.Scheme != "postgres" && u.Scheme != "postgresql") {
			r.fail("DB_URL muss eine postgres://-URL sein")
			return "", ""
		}
		u.User = url.UserPassword(user, password)
		d := *u
		d.User = url.User(user)
		return u.String(), d.String()
	}
	host := r.str("DB_HOST", "localhost")
	port := r.integer("DB_PORT", 5432, 1, 65535)
	name := r.str("DB_NAME", "berichtly")
	sslMode := r.str("DB_SSLMODE", "prefer")
	if !regexp.MustCompile(`^[A-Za-z0-9._-]+$`).MatchString(host) || !regexp.MustCompile(`^[A-Za-z0-9_-]+$`).MatchString(name) {
		r.fail("DB_HOST oder DB_NAME enthält ungültige Zeichen")
	}
	if !oneOf(sslMode, "disable", "allow", "prefer", "require", "verify-ca", "verify-full") {
		r.fail("DB_SSLMODE ist ungültig")
	}
	u := url.URL{
		Scheme:   "postgres",
		User:     url.UserPassword(user, password),
		Host:     fmt.Sprintf("%s:%d", host, port),
		Path:     "/" + name,
		RawQuery: "sslmode=" + sslMode,
	}
	d := u
	d.User = url.User(user)
	return u.String(), d.String()
}

func oneOf(v string, options ...string) bool {
	for _, o := range options {
		if v == o {
			return true
		}
	}
	return false
}
