// Berichtly Server – Linux-Backend für die Berichtly-Android-App.
package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	// Zeitzonendaten einbetten: funktioniert auch in minimalen Containern ohne /usr/share/zoneinfo.
	_ "time/tzdata"

	"berichtly-server/internal/app"
	"berichtly-server/internal/config"
)

const usage = `Berichtly Server – Backend für die Berichtly-Android-App

Verwendung: berichtly-server [--env-file <pfad>] <befehl>

Befehle:
  serve          Server starten (Standard). Beenden mit SIGTERM/Strg+C (kontrollierter Shutdown).
  migrate        Datenbankmigrationen ausführen und beenden.
  check-config   Konfiguration prüfen (ohne Secrets auszugeben) und beenden.
  healthcheck    Health-Check des laufenden Servers abfragen (Exit-Code 0 = gesund).
  seed-dev       Entwicklungskonto mit Beispieldaten anlegen (nur APP_ENV=development).
  version        Version anzeigen.
  help           Diese Hilfe anzeigen.

Die Konfiguration erfolgt über Umgebungsvariablen (siehe .env.example).
`

func main() {
	args := os.Args[1:]
	envFile := ""
	if len(args) >= 1 && args[0] == "--env-file" {
		if len(args) < 2 {
			fail(2, "--env-file benötigt einen Pfad")
		}
		envFile, args = args[1], args[2:]
	}
	cmd := "serve"
	if len(args) > 0 {
		cmd = args[0]
	}

	switch cmd {
	case "help", "-h", "--help":
		fmt.Print(usage)
	case "version", "--version":
		fmt.Println("Berichtly Server", app.Version)
	case "healthcheck":
		healthcheck(loadEnv(envFile))
	case "check-config":
		cfg := loadConfig(envFile)
		fmt.Println("Konfiguration gültig.")
		fmt.Println(cfg.Summary())
	case "migrate":
		cfg := loadConfig(envFile)
		a := newApp(cfg)
		defer a.DB.Close()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
		defer cancel()
		if _, err := a.DB.Migrate(ctx, a.Log); err != nil {
			a.Log.Error("Migration fehlgeschlagen", "error", err.Error())
			a.DB.Close()
			os.Exit(1)
		}
	case "seed-dev":
		cfg := loadConfig(envFile)
		a := newApp(cfg)
		defer a.DB.Close()
		ctx := context.Background()
		if _, err := a.DB.Migrate(ctx, a.Log); err != nil {
			fail(1, "Migration fehlgeschlagen: "+err.Error())
		}
		email, password, err := a.SeedDev(ctx)
		if err != nil {
			fail(1, err.Error())
		}
		fmt.Printf("Entwicklungskonto angelegt:\n  E-Mail:   %s\n  Passwort: %s\n(Das Passwort wird nicht gespeichert und nur jetzt angezeigt.)\n", email, password)
	case "serve":
		serve(loadConfig(envFile))
	default:
		fail(2, "Unbekannter Befehl: "+cmd+"\n\n"+usage)
	}
}

func serve(cfg *config.Config) {
	a := newApp(cfg)
	log := a.Log
	log.Info("Starte Berichtly Server", "version", app.Version, "environment", cfg.Env)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	if cfg.Database.MigrateOnStart {
		mctx, cancel := context.WithTimeout(ctx, 5*time.Minute)
		_, err := a.DB.Migrate(mctx, log)
		cancel()
		if err != nil {
			log.Error("Datenbankmigration beim Start fehlgeschlagen – Server wird nicht gestartet", "error", err.Error())
			a.DB.Close()
			os.Exit(1)
		}
	}

	srv := &http.Server{
		Addr:              net.JoinHostPort(cfg.Server.Host, strconv.Itoa(cfg.Server.Port)),
		Handler:           a.Handler,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       120 * time.Second,
		MaxHeaderBytes:    64 << 10,
	}
	errCh := make(chan error, 1)
	go func() {
		log.Info("Server lauscht", "address", srv.Addr)
		errCh <- srv.ListenAndServe()
	}()

	select {
	case err := <-errCh:
		if !errors.Is(err, http.ErrServerClosed) {
			log.Error("Server konnte nicht gestartet werden", "error", err.Error())
			a.DB.Close()
			os.Exit(1)
		}
	case <-ctx.Done():
		// Kontrollierter Shutdown (SIGTERM durch systemd/Docker, Strg+C): keine neuen Verbindungen,
		// laufende Requests werden beendet, danach wird der Datenbank-Pool geschlossen.
		log.Info("Shutdown eingeleitet – laufende Requests werden beendet", "timeout", cfg.Server.ShutdownTimeout.String())
		sctx, cancel := context.WithTimeout(context.Background(), cfg.Server.ShutdownTimeout)
		defer cancel()
		if err := srv.Shutdown(sctx); err != nil {
			log.Warn("Nicht alle Requests wurden rechtzeitig beendet", "error", err.Error())
		}
	}
	a.DB.Close()
	log.Info("Server beendet")
}

func healthcheck(env map[string]string) {
	port := 8080
	if p, err := strconv.Atoi(env["SERVER_PORT"]); err == nil {
		port = p
	}
	host := env["SERVER_HOST"]
	if host == "" || host == "0.0.0.0" || host == "::" {
		host = "127.0.0.1"
	}
	url := "http://" + net.JoinHostPort(host, strconv.Itoa(port)) + "/api/v1/health"
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Get(url)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Server nicht erreichbar (%s)\n", url)
		os.Exit(1)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		fmt.Fprintf(os.Stderr, "Nicht gesund – HTTP %d von %s\n", resp.StatusCode, url)
		os.Exit(1)
	}
	fmt.Println("OK – Server und Datenbank erreichbar.")
}

func loadEnv(envFile string) map[string]string {
	env := config.EnvMap(os.Environ())
	if envFile == "" {
		return env
	}
	merged, err := config.MergeEnvFile(envFile, env)
	if err != nil {
		fail(2, err.Error())
	}
	return merged
}

func loadConfig(envFile string) *config.Config {
	cfg, err := config.Load(loadEnv(envFile))
	if err != nil {
		fail(2, err.Error())
	}
	return cfg
}

func newApp(cfg *config.Config) *app.App {
	log := app.NewLogger(cfg.Log, os.Stdout)
	a, err := app.New(context.Background(), cfg, log, time.Now)
	if err != nil {
		fail(1, err.Error())
	}
	return a
}

func fail(code int, msg string) {
	fmt.Fprintln(os.Stderr, msg)
	os.Exit(code)
}
