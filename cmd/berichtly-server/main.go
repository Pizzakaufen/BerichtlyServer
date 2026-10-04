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
	"berichtly-server/internal/store"
)

const usage = `Berichtly Server – Backend für die Berichtly-Android-App

Verwendung: berichtly-server [--env-file <pfad>] <befehl>

Befehle:
  serve          Server starten (Standard). Beenden mit SIGTERM/Strg+C (kontrollierter Shutdown).
  migrate        Datenbankmigrationen ausführen und beenden.
  migrate-status Stand der Datenbankmigrationen anzeigen (angewendet, ausstehend, verändert).
  db-check       Datenbankverbindung und Schema-Version prüfen (Exit-Code 0 = in Ordnung).
  maintenance    Wartung jetzt ausführen: abgelaufene Tombstones, Sync-Operationen,
                 Sicherheitsereignisse und Sitzungen gemäß Aufbewahrungsfristen entfernen.
  reset-sync-cursors
                 Nach dem Einspielen eines Backups: alle Sync-Cursor ungültig machen, damit
                 jedes Gerät einmal vollständig neu synchronisiert.
  check-config   Konfiguration prüfen (ohne Secrets auszugeben) und beenden.
  healthcheck    Readiness des laufenden Servers abfragen (Exit-Code 0 = bereit).
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
	case "migrate-status":
		migrateStatus(loadConfig(envFile))
	case "db-check":
		dbCheck(loadConfig(envFile))
	case "maintenance":
		cfg := loadConfig(envFile)
		a := newApp(cfg)
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
		res, err := a.RunMaintenance(ctx)
		cancel()
		a.DB.Close()
		if err != nil {
			fail(1, "Wartung fehlgeschlagen: "+err.Error())
		}
		if res.Skipped {
			fmt.Println("Wartung übersprungen: Ein anderer Wartungslauf ist gerade aktiv.")
			return
		}
		fmt.Printf(`Wartung abgeschlossen:
  Tombstones entfernt:          %d
  Gültige Sync-Cursor ab:       %d
  Sync-Operationen entfernt:    %d
  Sicherheitsereignisse entf.:  %d
  Sitzungen entfernt:           %d
  Refresh Tokens entfernt:      %d
`,
			res.TombstonesPurged, res.MinValidCursor, res.OperationsPurged, res.SecurityEventsPurged, res.SessionsPurged, res.RefreshTokensPurged)
	case "reset-sync-cursors":
		cfg := loadConfig(envFile)
		a := newApp(cfg)
		ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
		err := a.DB.InvalidateSyncCursors(ctx)
		cancel()
		a.DB.Close()
		if err != nil {
			fail(1, "Zurücksetzen fehlgeschlagen: "+err.Error())
		}
		a.Log.Warn("Alle Sync-Cursor wurden ungültig gemacht – Geräte synchronisieren beim nächsten Mal vollständig neu")
		fmt.Println("Sync-Cursor zurückgesetzt. Alle Geräte erhalten beim nächsten Abruf SYNC_CURSOR_EXPIRED und synchronisieren vollständig neu.")
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
	if v, err := a.DB.SchemaVersion(ctx); err != nil {
		log.Warn("Schema-Version konnte nicht geprüft werden (Datenbank nicht erreichbar?)", "error", err.Error())
	} else if v < store.LatestSchemaVersion() {
		log.Error("Datenbankschema ist veraltet – bitte zuerst 'berichtly-server migrate' ausführen",
			"schema_version", v, "required", store.LatestSchemaVersion())
		a.DB.Close()
		os.Exit(1)
	} else if v > store.LatestSchemaVersion() {
		log.Warn("Datenbankschema ist neuer als diese Programmversion (Downgrade?)", "schema_version", v,
			"known", store.LatestSchemaVersion())
	}
	a.StartMaintenance(ctx)

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
	url := "http://" + net.JoinHostPort(host, strconv.Itoa(port)) + "/api/v1/health/ready"
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

func migrateStatus(cfg *config.Config) {
	a := newApp(cfg)
	defer a.DB.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	states, err := a.DB.MigrationStatus(ctx)
	if err != nil {
		a.DB.Close()
		fail(1, "Migrationsstatus nicht abrufbar: "+err.Error())
	}
	pending, problems := 0, 0
	fmt.Println("Version  Status    Angewendet (UTC)      Name")
	for _, s := range states {
		applied := "-"
		if s.AppliedAt != nil {
			applied = s.AppliedAt.UTC().Format("2006-01-02 15:04:05")
		}
		fmt.Printf("%04d     %-9s %-21s %s\n", s.Version, s.State, applied, s.Name)
		switch s.State {
		case "pending":
			pending++
		case "modified", "unknown":
			problems++
		}
	}
	fmt.Printf("\nAusstehend: %d, Auffällig: %d (Programmversion %s, erwartet Schema %d)\n",
		pending, problems, app.Version, store.LatestSchemaVersion())
	if problems > 0 {
		a.DB.Close()
		os.Exit(1)
	}
}

func dbCheck(cfg *config.Config) {
	a := newApp(cfg)
	defer a.DB.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	start := time.Now()
	if err := a.DB.Ping(ctx); err != nil {
		a.DB.Close()
		fail(1, "Datenbank nicht erreichbar ("+cfg.Database.Display+"): "+err.Error())
	}
	latency := time.Since(start)
	var serverVersion string
	_ = a.DB.Pool.QueryRow(ctx, `SHOW server_version`).Scan(&serverVersion)
	v, err := a.DB.SchemaVersion(ctx)
	if err != nil {
		a.DB.Close()
		fail(1, "Schema-Version nicht lesbar: "+err.Error())
	}
	fmt.Printf("Datenbank erreichbar: %s\n  PostgreSQL:     %s\n  Antwortzeit:    %s\n  Schema-Version: %d (erwartet %d)\n",
		cfg.Database.Display, serverVersion, latency.Round(time.Millisecond), v, store.LatestSchemaVersion())
	if v != store.LatestSchemaVersion() {
		fmt.Println("Hinweis: Schema nicht aktuell – 'berichtly-server migrate' ausführen.")
		a.DB.Close()
		os.Exit(1)
	}
}
