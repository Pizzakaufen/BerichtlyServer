package config

import (
	"encoding/base64"
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
