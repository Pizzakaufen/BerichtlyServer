package config

import (
	"encoding/base64"
	"os"
	"regexp"
	"strings"
	"testing"
)

func base() map[string]string {
	return map[string]string{
		"APP_ENV":     "test",
		"DB_USER":     "berichtly",
		"DB_PASSWORD": "geheim",
		"JWT_SECRET":  base64.StdEncoding.EncodeToString([]byte("0123456789abcdefghijklmnopqrstuvwxyzABCDEF")),
	}
}

func with(kv ...string) map[string]string {
	m := base()
	for i := 0; i+1 < len(kv); i += 2 {
		if kv[i+1] == "<unset>" {
			delete(m, kv[i])
		} else {
			m[kv[i]] = kv[i+1]
		}
	}
	return m
}

func TestFehlendeOderSchwacheSecretsVerhindernDenStart(t *testing.T) {
	for _, env := range []map[string]string{
		with("JWT_SECRET", "<unset>"),
		with("JWT_SECRET", "zu-kurz"),
		with("JWT_SECRET", base64.StdEncoding.EncodeToString([]byte(strings.Repeat("A", 64)))),
		with("DB_PASSWORD", "<unset>"),
		with("INTERNAL_STATUS_TOKEN", "kurz"),
	} {
		if _, err := Load(env); err == nil {
			t.Fatalf("Konfiguration hätte abgelehnt werden müssen: %v", env)
		}
	}
}

func TestProduktionsstandards(t *testing.T) {
	if _, err := Load(with("APP_ENV", "production", "CORS_ALLOWED_ORIGINS", "*")); err == nil {
		t.Fatal("CORS-Wildcard in Produktion akzeptiert")
	}
	c, err := Load(with("APP_ENV", "<unset>"))
	if err != nil {
		t.Fatal(err)
	}
	if c.Env != Production || c.APIDocs || c.Log.Level != "info" || c.Log.Format != "json" ||
		c.Server.Host != "127.0.0.1" || c.Server.TrustProxy || c.Auth.AccessTokenTTL.Minutes() != 15 {
		t.Fatalf("unsichere Standardwerte: %+v", c)
	}
	if strings.Contains(c.Summary(), "geheim") || strings.Contains(c.Database.Display, "geheim") {
		t.Fatal("Secrets in der Konfigurationsausgabe")
	}
}

func TestUngueltigeWerte(t *testing.T) {
	for _, kv := range [][]string{
		{"SERVER_PORT", "99999"}, {"APP_ENV", "staging"}, {"DEFAULT_TIMEZONE", "Berlin"},
		{"CORS_ALLOWED_ORIGINS", "app.example.de"}, {"ACCESS_TOKEN_TTL_MINUTES", "1440"}, {"DB_SSLMODE", "egal"},
		{"DB_HOST", "host;drop"}, {"TRUST_PROXY", "vielleicht"},
	} {
		if _, err := Load(with(kv...)); err == nil {
			t.Fatalf("%v akzeptiert", kv)
		}
	}
}

func TestAufbewahrungUndRateLimitsKonfigurierbar(t *testing.T) {
	c, err := Load(base())
	if err != nil {
		t.Fatal(err)
	}
	if c.Retention.Tombstones.Hours() != 365*24 || c.Retention.Operations.Hours() != 30*24 || c.MaintenanceInterval.Hours() != 24 {
		t.Fatalf("%+v %v", c.Retention, c.MaintenanceInterval)
	}
	if c.RateLimit.LoginPerMinute != 10 || c.RateLimit.RegisterPerMinute != 5 || c.RateLimit.RefreshPerMinute != 30 ||
		c.RateLimit.LoginPerAccountPerMinute != 5 {
		t.Fatalf("%+v", c.RateLimit)
	}
	// Kompatibilität mit 1.0: RATE_LIMIT_AUTH_PER_MINUTE gilt weiterhin für alle Auth-Endpunkte.
	c, _ = Load(with("RATE_LIMIT_AUTH_PER_MINUTE", "20"))
	if c.RateLimit.LoginPerMinute != 20 || c.RateLimit.RegisterPerMinute != 20 || c.RateLimit.RefreshPerMinute != 20 {
		t.Fatalf("%+v", c.RateLimit)
	}
	for _, kv := range [][]string{{"TOMBSTONE_RETENTION_DAYS", "7"}, {"MAINTENANCE_INTERVAL_HOURS", "-1"},
		{"SYNC_OPERATION_RETENTION_DAYS", "0"}} {
		if _, err := Load(with(kv...)); err == nil {
			t.Fatalf("%v akzeptiert", kv)
		}
	}
	if c, _ := Load(with("MAINTENANCE_INTERVAL_HOURS", "0")); c.MaintenanceInterval != 0 {
		t.Fatal("Wartung nicht abschaltbar")
	}
}

// Jede gelesene Umgebungsvariable muss in .env.example dokumentiert sein, und die Beispieldatei
// muss (mit eingesetzten Secrets) eine gültige Konfiguration ergeben.
func TestEnvExampleVollstaendigUndGueltig(t *testing.T) {
	src, err := os.ReadFile("config.go")
	if err != nil {
		t.Fatal(err)
	}
	example, err := os.ReadFile("../../.env.example")
	if err != nil {
		t.Fatal(err)
	}
	keys := regexp.MustCompile(`r\.(?:str|integer|boolean|required|secret|optional)\("([A-Z_]+)"`).FindAllStringSubmatch(string(src), -1)
	keys = append(keys, regexp.MustCompile(`dayDur\("([A-Z_]+)"`).FindAllStringSubmatch(string(src), -1)...)
	if len(keys) < 30 {
		t.Fatalf("nur %d Variablen gefunden", len(keys))
	}
	for _, k := range keys {
		if !regexp.MustCompile(`(?m)^#? ?` + k[1] + `=`).Match(example) {
			t.Errorf("%s ist nicht in .env.example dokumentiert", k[1])
		}
	}
	env, err := MergeEnvFile("../../.env.example", map[string]string{
		"DB_PASSWORD": "beispiel",
		"JWT_SECRET":  base64.StdEncoding.EncodeToString([]byte("0123456789abcdefghijklmnopqrstuvwxyzABCDEF")),
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Load(env); err != nil {
		t.Fatal(".env.example ergibt keine gültige Konfiguration:", err)
	}
}
