// Package store kapselt den gesamten Datenbankzugriff (PostgreSQL über pgx).
//
// Alle Werte werden ausschließlich als Parameter ($1, $2, …) gebunden – Benutzereingaben werden
// nie in SQL-Strings eingesetzt (Schutz vor SQL-Injection).
package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// PoolConfig beschreibt den Connection-Pool.
type PoolConfig struct {
	URL             string
	MaxConns        int32
	MinConns        int32
	ConnectTimeout  time.Duration
	MaxConnLifetime time.Duration
	MaxConnIdleTime time.Duration
}

// DB ist der Einstiegspunkt für Datenbankzugriffe.
type DB struct {
	Pool *pgxpool.Pool
}

// Open erzeugt den Connection-Pool. Die Verbindung wird lazy aufgebaut; ein kurzzeitig
// nicht erreichbarer Datenbankserver verhindert den Start daher nicht (der Health-Check meldet es).
func Open(ctx context.Context, cfg PoolConfig) (*DB, error) {
	pc, err := pgxpool.ParseConfig(cfg.URL)
	if err != nil {
		return nil, fmt.Errorf("ungültige Datenbank-URL: %w", err)
	}
	pc.MaxConns = cfg.MaxConns
	pc.MinConns = cfg.MinConns
	pc.MaxConnLifetime = cfg.MaxConnLifetime
	pc.MaxConnIdleTime = cfg.MaxConnIdleTime
	pc.ConnConfig.ConnectTimeout = cfg.ConnectTimeout
	if pc.ConnConfig.RuntimeParams == nil {
		pc.ConnConfig.RuntimeParams = map[string]string{}
	}
	pc.ConnConfig.RuntimeParams["application_name"] = "berichtly-server"
	pc.ConnConfig.RuntimeParams["timezone"] = "UTC"
	pool, err := pgxpool.NewWithConfig(ctx, pc)
	if err != nil {
		return nil, fmt.Errorf("Connection-Pool konnte nicht erstellt werden: %w", err)
	}
	return &DB{Pool: pool}, nil
}

// Close schließt alle Verbindungen (beim kontrollierten Shutdown).
func (db *DB) Close() { db.Pool.Close() }

// Ping prüft, ob die Datenbank erreichbar ist.
func (db *DB) Ping(ctx context.Context) error {
	return db.Pool.Ping(ctx)
}

// Tx führt fn in genau einer Transaktion aus. Fehler oder Panics führen zum Rollback.
func (db *DB) Tx(ctx context.Context, fn func(tx pgx.Tx) error) error {
	return pgx.BeginTxFunc(ctx, db.Pool, pgx.TxOptions{IsoLevel: pgx.ReadCommitted}, fn)
}

// Snapshot führt fn in einer lesenden Transaktion mit genau einem konsistenten Datenbank-Snapshot
// aus (REPEATABLE READ). Nötig, wenn mehrere Abfragen zusammen ein widerspruchsfreies Bild ergeben
// müssen – z. B. beim Synchronisations-Pull über mehrere Tabellen.
func (db *DB) Snapshot(ctx context.Context, fn func(tx pgx.Tx) error) error {
	return pgx.BeginTxFunc(ctx, db.Pool, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly}, fn)
}

// LockUser sperrt die Benutzerzeile bis zum Ende der Transaktion. Damit werden alle
// Schreibvorgänge eines Kontos serialisiert und Änderungsnummern in Commit-Reihenfolge vergeben
// (siehe docs/SYNC.md).
func LockUser(ctx context.Context, tx pgx.Tx, userID uuid.UUID) error {
	var id uuid.UUID
	return tx.QueryRow(ctx, `SELECT id FROM users WHERE id = $1 FOR UPDATE`, userID).Scan(&id)
}

// IsUniqueViolation erkennt die Verletzung eines Unique-Constraints.
func IsUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}

// IsNoRows erkennt "kein Ergebnis".
func IsNoRows(err error) bool { return errors.Is(err, pgx.ErrNoRows) }

// Querier wird von Pool und Transaktion implementiert.
type Querier interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}
