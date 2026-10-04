// Package service enthält die Geschäftslogik. Jede öffentliche Methode bindet alle Zugriffe an
// die Benutzer-ID des authentifizierten Benutzers – fremde Datensätze sind weder sichtbar noch änderbar.
package service

import (
	"context"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"berichtly-server/internal/apperr"
	"berichtly-server/internal/model"
	"berichtly-server/internal/store"
)

// OutcomeKind ist das Ergebnis einer schreibenden Operation auf einem synchronisierbaren Datensatz.
type OutcomeKind int

const (
	Applied OutcomeKind = iota
	Conflicted
	NotFound
)

// Outcome wird von REST-Endpunkten und Synchronisations-API gleichermaßen verwendet, damit beide
// exakt dieselben Konfliktregeln haben.
type Outcome[R any] struct {
	Kind    OutcomeKind
	Record  *R // Applied: neuer Stand; Conflicted: aktueller Serverstand (nil, wenn nicht sichtbar)
	Created bool
	Changed bool // false bei idempotenter Wiederholung
	Reason  apperr.ConflictReason
}

// VersionedStore ist der Datenbankzugriff, den VersionedWriter für einen Datensatztyp benötigt.
type VersionedStore[V any, R any] interface {
	// FindByID sucht unabhängig vom Besitzer (nur intern, um ID-Kollisionen zu erkennen).
	FindByID(ctx context.Context, tx pgx.Tx, id uuid.UUID, forUpdate bool) (*R, error)
	Insert(ctx context.Context, tx pgx.Tx, userID, id uuid.UUID, v V, m model.WriteMeta) (*R, error)
	// Update ändert nur bei passender Version (nil = Version weicht ab) und erhöht die Version.
	Update(ctx context.Context, tx pgx.Tx, id uuid.UUID, expected int, v V, m model.WriteMeta) (*R, error)
	// SoftDelete legt einen Tombstone an (nil = Version weicht ab).
	SoftDelete(ctx context.Context, tx pgx.Tx, id uuid.UUID, expected int, m model.WriteMeta) (*R, error)
	// FindCollision liefert einen anderen aktiven Datensatz, mit dem v fachlich kollidieren würde.
	FindCollision(ctx context.Context, tx pgx.Tx, userID, excludeID uuid.UUID, v V) (*R, error)
	Owner(r *R) uuid.UUID
	Version(r *R) int
	Deleted(r *R) bool
	Same(r *R, v V) bool
}

// VersionedWriter implementiert die Schreibregeln mit optimistischer Sperre (siehe docs/SYNC.md):
//   - Erstellen mit einer bereits verwendeten ID überschreibt nie; identischer Inhalt gilt als
//     idempotente Wiederholung.
//   - Ändern/Löschen nur, wenn die Basisversion des Clients der Serverversion entspricht.
//   - Konflikte liefern den aktuellen Serverstand, statt Daten stillschweigend zu überschreiben
//     (kein "Last Write Wins").
//   - Schreibvorgänge eines Kontos werden über eine Zeilensperre serialisiert, damit
//     Änderungsnummern in Commit-Reihenfolge vergeben werden.
type VersionedWriter[V any, R any] struct {
	DB    *store.DB
	Store VersionedStore[V, R]
}

func (w VersionedWriter[V, R]) Create(ctx context.Context, userID, id uuid.UUID, v V, m model.WriteMeta) (out Outcome[R], err error) {
	err = w.DB.Tx(ctx, func(tx pgx.Tx) error {
		out, err = w.CreateTx(ctx, tx, userID, id, v, m)
		return err
	})
	return out, err
}

func (w VersionedWriter[V, R]) Update(ctx context.Context, userID, id uuid.UUID, base int, v V, m model.WriteMeta) (out Outcome[R], err error) {
	err = w.DB.Tx(ctx, func(tx pgx.Tx) error {
		out, err = w.UpdateTx(ctx, tx, userID, id, base, v, m)
		return err
	})
	return out, err
}

func (w VersionedWriter[V, R]) Delete(ctx context.Context, userID, id uuid.UUID, base int, m model.WriteMeta) (out Outcome[R], err error) {
	err = w.DB.Tx(ctx, func(tx pgx.Tx) error {
		out, err = w.DeleteTx(ctx, tx, userID, id, base, m)
		return err
	})
	return out, err
}

// CreateTx arbeitet in einer bestehenden Transaktion (für atomare Synchronisationsoperationen).
func (w VersionedWriter[V, R]) CreateTx(ctx context.Context, tx pgx.Tx, userID, id uuid.UUID, v V, m model.WriteMeta) (Outcome[R], error) {
	if err := store.LockUser(ctx, tx, userID); err != nil {
		return Outcome[R]{}, err
	}
	existing, err := w.Store.FindByID(ctx, tx, id, true)
	if err != nil {
		return Outcome[R]{}, err
	}
	if existing != nil {
		switch {
		case w.Store.Owner(existing) != userID:
			return Outcome[R]{Kind: Conflicted, Reason: apperr.ReasonIDUnavailable}, nil
		case w.Store.Deleted(existing):
			return Outcome[R]{Kind: Conflicted, Record: existing, Reason: apperr.ReasonDeletedOnServer}, nil
		case w.Store.Same(existing, v):
			return Outcome[R]{Kind: Applied, Record: existing}, nil
		default:
			return Outcome[R]{Kind: Conflicted, Record: existing, Reason: apperr.ReasonAlreadyExists}, nil
		}
	}
	collision, err := w.Store.FindCollision(ctx, tx, userID, id, v)
	if err != nil {
		return Outcome[R]{}, err
	}
	if collision != nil {
		return Outcome[R]{Kind: Conflicted, Record: collision, Reason: apperr.ReasonDuplicateWeek}, nil
	}
	created, err := w.Store.Insert(ctx, tx, userID, id, v, m)
	if err != nil {
		return Outcome[R]{}, err
	}
	return Outcome[R]{Kind: Applied, Record: created, Created: true, Changed: true}, nil
}

func (w VersionedWriter[V, R]) UpdateTx(ctx context.Context, tx pgx.Tx, userID, id uuid.UUID, base int, v V, m model.WriteMeta) (Outcome[R], error) {
	existing, err := w.lockOwned(ctx, tx, userID, id)
	if err != nil || existing == nil {
		return Outcome[R]{Kind: NotFound}, err
	}
	switch {
	case w.Store.Deleted(existing):
		return Outcome[R]{Kind: Conflicted, Record: existing, Reason: apperr.ReasonDeletedOnServer}, nil
	case w.Store.Same(existing, v):
		return Outcome[R]{Kind: Applied, Record: existing}, nil
	case w.Store.Version(existing) != base:
		return Outcome[R]{Kind: Conflicted, Record: existing, Reason: apperr.ReasonVersionMismatch}, nil
	}
	collision, err := w.Store.FindCollision(ctx, tx, userID, id, v)
	if err != nil {
		return Outcome[R]{}, err
	}
	if collision != nil {
		return Outcome[R]{Kind: Conflicted, Record: collision, Reason: apperr.ReasonDuplicateWeek}, nil
	}
	updated, err := w.Store.Update(ctx, tx, id, base, v, m)
	if err != nil {
		return Outcome[R]{}, err
	}
	if updated == nil {
		return Outcome[R]{Kind: Conflicted, Record: existing, Reason: apperr.ReasonVersionMismatch}, nil
	}
	return Outcome[R]{Kind: Applied, Record: updated, Changed: true}, nil
}

func (w VersionedWriter[V, R]) DeleteTx(ctx context.Context, tx pgx.Tx, userID, id uuid.UUID, base int, m model.WriteMeta) (Outcome[R], error) {
	existing, err := w.lockOwned(ctx, tx, userID, id)
	if err != nil || existing == nil {
		return Outcome[R]{Kind: NotFound}, err
	}
	switch {
	case w.Store.Deleted(existing):
		return Outcome[R]{Kind: Applied, Record: existing}, nil // idempotent
	case w.Store.Version(existing) != base:
		return Outcome[R]{Kind: Conflicted, Record: existing, Reason: apperr.ReasonVersionMismatch}, nil
	}
	deleted, err := w.Store.SoftDelete(ctx, tx, id, base, m)
	if err != nil {
		return Outcome[R]{}, err
	}
	if deleted == nil {
		return Outcome[R]{Kind: Conflicted, Record: existing, Reason: apperr.ReasonVersionMismatch}, nil
	}
	return Outcome[R]{Kind: Applied, Record: deleted, Changed: true}, nil
}

// lockOwned sperrt Benutzer und Datensatz; fremde Datensätze verhalten sich wie nicht vorhandene.
func (w VersionedWriter[V, R]) lockOwned(ctx context.Context, tx pgx.Tx, userID, id uuid.UUID) (*R, error) {
	if err := store.LockUser(ctx, tx, userID); err != nil {
		return nil, err
	}
	existing, err := w.Store.FindByID(ctx, tx, id, true)
	if err != nil || existing == nil || w.Store.Owner(existing) != userID {
		return nil, err
	}
	return existing, nil
}

// RequireApplied übersetzt ein Ergebnis für REST: Konflikt → 409 mit Serverstand, fehlt → 404.
func RequireApplied[R any](out Outcome[R], what string, version func(*R) int, dto func(*R) any) (*R, error) {
	switch out.Kind {
	case Applied:
		return out.Record, nil
	case Conflicted:
		info := apperr.ConflictInfo{Reason: out.Reason}
		if out.Record != nil {
			v := version(out.Record)
			info.ServerVersion = &v
			info.ServerRecord = dto(out.Record)
		}
		return nil, apperr.Conflict(info)
	default:
		return nil, apperr.NotFound(what)
	}
}
