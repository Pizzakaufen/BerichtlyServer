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
	"time"

	"github.com/jackc/pgx/v5"
)

//go:embed migrations/*.sql
var migrationFiles embed.FS

// migrationLockID ist eine feste Kennung für pg_advisory_lock, damit nie zwei Prozesse
// gleichzeitig migrieren (z. B. zwei Container, die gleichzeitig starten).
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

// LatestSchemaVersion ist die höchste in dieser Programmversion enthaltene Migration.
func LatestSchemaVersion() int {
	m, err := loadMigrations()
	if err != nil || len(m) == 0 {
		return 0
	}
	return m[len(m)-1].version
}

// Migrate wendet alle fehlenden Migrationen an. Siehe MigrateTo.
func (db *DB) Migrate(ctx context.Context, log *slog.Logger) (int, error) {
	return db.MigrateTo(ctx, log, 0)
}

// MigrateTo wendet fehlende Migrationen bis einschließlich target an (0 = alle). Jede Migration
// läuft in einer eigenen Transaktion; der gesamte Lauf ist über eine Advisory-Lock gegen parallele
// Ausführung geschützt. Bereits angewendete Migrationen werden per Prüfsumme kontrolliert.
// Liefert die Anzahl neu angewendeter Migrationen.
func (db *DB) MigrateTo(ctx context.Context, log *slog.Logger, target int) (int, error) {
	migrations, err := loadMigrations()
	if err != nil {
		return 0, err
	}
	conn, err := db.Pool.Acquire(ctx)
	if err != nil {
		return 0, fmt.Errorf("Datenbank nicht erreichbar: %w", err)
	}
	defer conn.Release()
	if _, err := conn.Exec(ctx, `SELECT pg_advisory_lock($1)`, migrationLockID); err != nil {
		return 0, err
	}
	defer func() {
		// Mit eigenem Kontext, damit die Sperre auch bei abgebrochenem ctx freigegeben wird.
		uctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_, _ = conn.Exec(uctx, `SELECT pg_advisory_unlock($1)`, migrationLockID)
	}()

	if _, err := conn.Exec(ctx, `
		CREATE TABLE IF NOT EXISTS schema_migrations (
			version    INTEGER PRIMARY KEY,
			name       TEXT        NOT NULL,
			checksum   TEXT        NOT NULL,
			applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
		)`); err != nil {
		return 0, fmt.Errorf("Migrationstabelle: %w", err)
	}
	applied, err := appliedMigrations(ctx, conn)
	if err != nil {
		return 0, err
	}

	count := 0
	for _, m := range migrations {
		if target > 0 && m.version > target {
			break
		}
		if a, ok := applied[m.version]; ok {
			if a.checksum != m.checksum {
				return count, fmt.Errorf("Migration %04d_%s wurde nach dem Anwenden verändert (Prüfsumme weicht ab) – "+
					"Änderungen immer als neue Migration anlegen", m.version, m.name)
			}
			continue
		}
		err := pgx.BeginTxFunc(ctx, conn, pgx.TxOptions{}, func(tx pgx.Tx) error {
			// Ohne Parameter nutzt pgx das einfache Protokoll, das mehrere Anweisungen erlaubt.
			if _, err := tx.Exec(ctx, m.sql); err != nil {
				return fmt.Errorf("Migration %04d_%s fehlgeschlagen: %w", m.version, m.name, err)
			}
			_, err := tx.Exec(ctx, `INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)`,
				m.version, m.name, m.checksum)
			return err
		})
		if err != nil {
			return count, err
		}
		count++
		log.Info("Migration angewendet", "version", m.version, "name", m.name)
	}
	version, _ := db.SchemaVersion(ctx)
	log.Info("Datenbankmigrationen abgeschlossen", "applied", count, "schema_version", version)
	return count, nil
}

type appliedMigration struct {
	name, checksum string
	appliedAt      time.Time
}

func appliedMigrations(ctx context.Context, q Querier) (map[int]appliedMigration, error) {
	rows, err := q.Query(ctx, `SELECT version, name, checksum, applied_at FROM schema_migrations`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[int]appliedMigration{}
	for rows.Next() {
		var v int
		var a appliedMigration
		if err := rows.Scan(&v, &a.name, &a.checksum, &a.appliedAt); err != nil {
			return nil, err
		}
		out[v] = a
	}
	return out, rows.Err()
}

// MigrationState beschreibt den Stand einer Migration für `migrate-status`.
type MigrationState struct {
	Version   int
	Name      string
	State     string // applied | pending | modified | unknown
	AppliedAt *time.Time
}

// MigrationStatus vergleicht eingebettete und angewendete Migrationen.
func (db *DB) MigrationStatus(ctx context.Context) ([]MigrationState, error) {
	migrations, err := loadMigrations()
	if err != nil {
		return nil, err
	}
	var exists bool
	if err := db.Pool.QueryRow(ctx, `SELECT to_regclass('schema_migrations') IS NOT NULL`).Scan(&exists); err != nil {
		return nil, err
	}
	applied := map[int]appliedMigration{}
	if exists {
		if applied, err = appliedMigrations(ctx, db.Pool); err != nil {
			return nil, err
		}
	}
	var out []MigrationState
	known := map[int]bool{}
	for _, m := range migrations {
		known[m.version] = true
		s := MigrationState{Version: m.version, Name: m.name, State: "pending"}
		if a, ok := applied[m.version]; ok {
			t := a.appliedAt
			s.AppliedAt = &t
			s.State = "applied"
			if a.checksum != m.checksum {
				s.State = "modified"
			}
		}
		out = append(out, s)
	}
	// Migrationen in der Datenbank, die diese Programmversion nicht kennt (z. B. nach Downgrade).
	for v, a := range applied {
		if !known[v] {
			t := a.appliedAt
			out = append(out, MigrationState{Version: v, Name: a.name, State: "unknown", AppliedAt: &t})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Version < out[j].Version })
	return out, nil
}

// SchemaVersion liefert die höchste angewendete Migrationsversion (0 = keine).
func (db *DB) SchemaVersion(ctx context.Context) (int, error) {
	var exists bool
	if err := db.Pool.QueryRow(ctx, `SELECT to_regclass('schema_migrations') IS NOT NULL`).Scan(&exists); err != nil || !exists {
		return 0, err
	}
	var v int
	err := db.Pool.QueryRow(ctx, `SELECT COALESCE(MAX(version), 0) FROM schema_migrations`).Scan(&v)
	return v, err
}
