// Package service enthält die Geschäftslogik. Jede öffentliche Methode bindet alle Zugriffe an
// die Benutzer-ID des authentifizierten Benutzers – fremde Datensätze sind weder sichtbar noch änderbar.
package service

import (
	"context"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"berichtly-server/internal/apperr"
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
	Insert(ctx context.Context, tx pgx.Tx, userID, id uuid.UUID, v V, deviceRef *uuid.UUID) (*R, error)
	// Update ändert nur bei passender Version (nil = Version weicht ab) und erhöht die Version.
	Update(ctx context.Context, tx pgx.Tx, id uuid.UUID, expected int, v V, deviceRef *uuid.UUID) (*R, error)
	// SoftDelete legt einen Tombstone an (nil = Version weicht ab).
	SoftDelete(ctx context.Context, tx pgx.Tx, id uuid.UUID, expected int, deviceRef *uuid.UUID) (*R, error)
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
//   - Konflikte liefern den aktuellen Serverstand, statt Daten stillschweigend zu überschreiben.
//   - Schreibvorgänge eines Kontos werden über eine Zeilensperre serialisiert.
type VersionedWriter[V any, R any] struct {
	DB    *store.DB
	Store VersionedStore[V, R]
}

func (w VersionedWriter[V, R]) Create(ctx context.Context, userID, id uuid.UUID, v V, deviceRef *uuid.UUID) (Outcome[R], error) {
	var out Outcome[R]
	err := w.DB.Tx(ctx, func(tx pgx.Tx) error {
		out = Outcome[R]{}
		if err := store.LockUser(ctx, tx, userID); err != nil {
			return err
		}
		existing, err := w.Store.FindByID(ctx, tx, id, true)
		if err != nil {
			return err
		}
		if existing != nil {
			switch {
			case w.Store.Owner(existing) != userID:
				out = Outcome[R]{Kind: Conflicted, Reason: apperr.ReasonIDUnavailable}
			case w.Store.Deleted(existing):
				out = Outcome[R]{Kind: Conflicted, Record: existing, Reason: apperr.ReasonDeletedOnServer}
			case w.Store.Same(existing, v):
				out = Outcome[R]{Kind: Applied, Record: existing}
			default:
				out = Outcome[R]{Kind: Conflicted, Record: existing, Reason: apperr.ReasonAlreadyExists}
			}
			return nil
		}
		collision, err := w.Store.FindCollision(ctx, tx, userID, id, v)
		if err != nil {
			return err
		}
		if collision != nil {
			out = Outcome[R]{Kind: Conflicted, Record: collision, Reason: apperr.ReasonDuplicateWeek}
			return nil
		}
		created, err := w.Store.Insert(ctx, tx, userID, id, v, deviceRef)
		if err != nil {
			return err
		}
		out = Outcome[R]{Kind: Applied, Record: created, Created: true, Changed: true}
		return nil
	})
	return out, err
}

func (w VersionedWriter[V, R]) Update(ctx context.Context, userID, id uuid.UUID, base int, v V, deviceRef *uuid.UUID) (Outcome[R], error) {
	var out Outcome[R]
	err := w.DB.Tx(ctx, func(tx pgx.Tx) error {
		out = Outcome[R]{}
		existing, err := w.lockOwned(ctx, tx, userID, id)
		if err != nil || existing == nil {
			out.Kind = NotFound
			return err
		}
		switch {
		case w.Store.Deleted(existing):
			out = Outcome[R]{Kind: Conflicted, Record: existing, Reason: apperr.ReasonDeletedOnServer}
			return nil
		case w.Store.Same(existing, v):
			out = Outcome[R]{Kind: Applied, Record: existing}
			return nil
		case w.Store.Version(existing) != base:
			out = Outcome[R]{Kind: Conflicted, Record: existing, Reason: apperr.ReasonVersionMismatch}
			return nil
		}
		collision, err := w.Store.FindCollision(ctx, tx, userID, id, v)
		if err != nil {
			return err
		}
		if collision != nil {
			out = Outcome[R]{Kind: Conflicted, Record: collision, Reason: apperr.ReasonDuplicateWeek}
			return nil
		}
		updated, err := w.Store.Update(ctx, tx, id, base, v, deviceRef)
		if err != nil {
			return err
		}
		if updated == nil {
			out = Outcome[R]{Kind: Conflicted, Record: existing, Reason: apperr.ReasonVersionMismatch}
			return nil
		}
		out = Outcome[R]{Kind: Applied, Record: updated, Changed: true}
		return nil
	})
	return out, err
}

func (w VersionedWriter[V, R]) Delete(ctx context.Context, userID, id uuid.UUID, base int, deviceRef *uuid.UUID) (Outcome[R], error) {
	var out Outcome[R]
	err := w.DB.Tx(ctx, func(tx pgx.Tx) error {
		out = Outcome[R]{}
		existing, err := w.lockOwned(ctx, tx, userID, id)
		if err != nil || existing == nil {
			out.Kind = NotFound
			return err
		}
		switch {
		case w.Store.Deleted(existing):
			out = Outcome[R]{Kind: Applied, Record: existing} // idempotent
			return nil
		case w.Store.Version(existing) != base:
			out = Outcome[R]{Kind: Conflicted, Record: existing, Reason: apperr.ReasonVersionMismatch}
			return nil
		}
		deleted, err := w.Store.SoftDelete(ctx, tx, id, base, deviceRef)
		if err != nil {
			return err
		}
		if deleted == nil {
			out = Outcome[R]{Kind: Conflicted, Record: existing, Reason: apperr.ReasonVersionMismatch}
			return nil
		}
		out = Outcome[R]{Kind: Applied, Record: deleted, Changed: true}
		return nil
	})
	return out, err
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
