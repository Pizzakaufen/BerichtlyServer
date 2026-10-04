// Package app verdrahtet Konfiguration, Datenbank, Services und HTTP-Schicht.
package app

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"berichtly-server/internal/config"
	"berichtly-server/internal/httpapi"
	"berichtly-server/internal/security"
	"berichtly-server/internal/service"
	"berichtly-server/internal/store"
)

// Version wird beim Bauen per -ldflags gesetzt.
var Version = "1.1.0"

type App struct {
	Cfg      *config.Config
	DB       *store.DB
	Log      *slog.Logger
	Auth     *service.Auth
	Reports  *service.Reports
	Profiles *service.Profiles
	Sync     *service.Sync
	Handler  http.Handler
}

// NewLogger erzeugt strukturiertes Logging (JSON in Produktion, Text in Entwicklung).
func NewLogger(cfg config.Log, out io.Writer) *slog.Logger {
	var level slog.Level
	_ = level.UnmarshalText([]byte(strings.ToUpper(cfg.Level)))
	opts := &slog.HandlerOptions{Level: level, ReplaceAttr: func(_ []string, a slog.Attr) slog.Attr {
		// Zeitstempel immer in UTC – unabhängig von der Zeitzone des Servers.
		if a.Key == slog.TimeKey && a.Value.Kind() == slog.KindTime {
			a.Value = slog.TimeValue(a.Value.Time().UTC())
		}
		return a
	}}
	if cfg.Format == "json" {
		return slog.New(slog.NewJSONHandler(out, opts))
	}
	return slog.New(slog.NewTextHandler(out, opts))
}

// New baut die Anwendung. now ist die Uhr für fachliche Berechnungen ("heute") und Tokens.
func New(ctx context.Context, cfg *config.Config, log *slog.Logger, now func() time.Time) (*App, error) {
	db, err := store.Open(ctx, store.PoolConfig{
		URL:             cfg.Database.URL,
		MaxConns:        cfg.Database.MaxConns,
		MinConns:        cfg.Database.MinConns,
		ConnectTimeout:  cfg.Database.ConnectTimeout,
		MaxConnLifetime: 30 * time.Minute,
		MaxConnIdleTime: 5 * time.Minute,
	})
	if err != nil {
		return nil, err
	}
	auth := &service.Auth{
		DB:     db,
		Cfg:    cfg.Auth,
		Hasher: security.NewPasswordHasher(),
		Tokens: security.NewTokens(cfg.Auth.JWTSecret, cfg.Auth.Issuer, cfg.Auth.Audience, cfg.Auth.AccessTokenTTL, now),
		Log:    log,
	}
	reports := service.NewReports(db, now)
	profiles := &service.Profiles{DB: db}
	syncSvc := &service.Sync{DB: db, Reports: reports, Profiles: profiles, Now: now, Log: log}
	handler := httpapi.New(httpapi.Deps{
		Config:   cfg,
		DB:       db,
		Log:      log,
		Auth:     auth,
		Account:  &service.Account{DB: db},
		Profiles: profiles,
		Reports:  reports,
		Sync:     syncSvc,
		Devices:  &service.Devices{DB: db, Log: log},
		Version:  Version,
	})
	return &App{Cfg: cfg, DB: db, Log: log, Auth: auth, Reports: reports, Profiles: profiles, Sync: syncSvc, Handler: handler}, nil
}
