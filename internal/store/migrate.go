package store

import (
	"context"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"fmt"
	"io/fs"
	"log/slog"
	"sort"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
)

//go:embed migrations/*.sql
var migrationFiles embed.FS

// migrationLockID ist eine feste Kennung für pg_advisory_xact_lock, damit nie zwei Prozesse
// gleichzeitig migrieren.
const migrationLockID = 726_174_520_031

type migration struct {
	version  int
	name     string
	sql      string
	checksum string
}

func loadMigrations() ([]migration, error) {
	entries, err := fs.ReadDir(migrationFiles, "migrations")
	if err != nil {
		return nil, err
	}
	var result []migration
	for _, e := range entries {
		// Format: 0001_beschreibung.sql
		name := e.Name()
		prefix, rest, ok := strings.Cut(strings.TrimSuffix(name, ".sql"), "_")
		version, convErr := strconv.Atoi(prefix)
		if !ok || convErr != nil || version <= 0 {
			return nil, fmt.Errorf("ungültiger Migrationsdateiname: %s", name)
		}
		content, err := migrationFiles.ReadFile("migrations/" + name)
		if err != nil {
			return nil, err
		}
		sum := sha256.Sum256(content)
		result = append(result, migration{version, rest, string(content), hex.EncodeToString(sum[:])})
	}
	sort.Slice(result, func(i, j int) bool { return result[i].version < result[j].version })
	for i := 1; i < len(result); i++ {
		if result[i].version == result[i-1].version {
			return nil, fmt.Errorf("doppelte Migrationsversion %d", result[i].version)
		}
	}
	return result, nil
}

// Migrate wendet alle noch fehlenden Migrationen an (jede in einer eigenen Transaktion) und
// prüft, dass bereits angewendete Migrationen nicht nachträglich verändert wurden.
// Liefert die Anzahl neu angewendeter Migrationen.
func (db *DB) Migrate(ctx context.Context, log *slog.Logger) (int, error) {
	migrations, err := loadMigrations()
	if err != nil {
		return 0, err
	}
	if _, err := db.Pool.Exec(ctx, `
		CREATE TABLE IF NOT EXISTS schema_migrations (
			version    INTEGER PRIMARY KEY,
			name       TEXT        NOT NULL,
			checksum   TEXT        NOT NULL,
			applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
		)`); err != nil {
		return 0, fmt.Errorf("Migrationstabelle: %w", err)
	}

	applied := 0
	for _, m := range migrations {
		done := false
		err := db.Tx(ctx, func(tx pgx.Tx) error {
			if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, migrationLockID); err != nil {
				return err
			}
			var checksum string
			err := tx.QueryRow(ctx, `SELECT checksum FROM schema_migrations WHERE version = $1`, m.version).Scan(&checksum)
			if err == nil {
				if checksum != m.checksum {
					return fmt.Errorf("Migration %04d_%s wurde nach dem Anwenden verändert (Prüfsumme weicht ab) – "+
						"Änderungen immer als neue Migration anlegen", m.version, m.name)
				}
				done = true
				return nil
			}
			if !IsNoRows(err) {
				return err
			}
			// Ohne Parameter nutzt pgx das einfache Protokoll, das mehrere Anweisungen erlaubt.
			if _, err := tx.Exec(ctx, m.sql); err != nil {
				return fmt.Errorf("Migration %04d_%s fehlgeschlagen: %w", m.version, m.name, err)
			}
			_, err = tx.Exec(ctx, `INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)`,
				m.version, m.name, m.checksum)
			return err
		})
		if err != nil {
			return applied, err
		}
		if !done {
			applied++
			log.Info("Migration angewendet", "version", m.version, "name", m.name)
		}
	}
	version, _ := db.SchemaVersion(ctx)
	log.Info("Datenbankmigrationen abgeschlossen", "applied", applied, "schema_version", version)
	return applied, nil
}

// SchemaVersion liefert die höchste angewendete Migrationsversion (0 = keine).
func (db *DB) SchemaVersion(ctx context.Context) (int, error) {
	var v int
	err := db.Pool.QueryRow(ctx, `SELECT COALESCE(MAX(version), 0) FROM schema_migrations`).Scan(&v)
	return v, err
}
