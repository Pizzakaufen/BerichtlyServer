package service

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"sort"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"berichtly-server/internal/apperr"
	"berichtly-server/internal/model"
	"berichtly-server/internal/store"
	"berichtly-server/internal/validate"
)

// Grenzen der Synchronisations-API.
const (
	MaxPushItems     = 100
	DefaultPullLimit = 200
	MaxPullLimit     = 500
)

var (
	syncTypes      = []string{"DAILY_REPORT", "WEEKLY_REPORT", "PROFILE"}
	syncOperations = []string{"UPSERT", "DELETE"}
)

// SyncChange ist eine Änderung auf dem Server. Gelöschte Datensätze erscheinen als Tombstone
// (deleted = true, data = null).
type SyncChange struct {
	Type      string `json:"type"`
	ID        string `json:"id"`
	Version   int    `json:"version"`
	ChangeSeq int64  `json:"changeSeq"`
	Deleted   bool   `json:"deleted"`
	UpdatedAt string `json:"updatedAt"`
	Data      any    `json:"data"`
}

type SyncPullResponse struct {
	Changes []SyncChange `json:"changes"`
	// Für den nächsten Abruf als `cursor` übergeben – erst nach erfolgreicher lokaler Übernahme speichern.
	NextCursor string `json:"nextCursor"`
	HasMore    bool   `json:"hasMore"`
	ServerTime string `json:"serverTime"`
}

type SyncPushItem struct {
	Type      *string `json:"type"`
	Operation *string `json:"operation"`
	ID        *string `json:"id"`
	// Version, auf der die lokale Änderung basiert. null = Datensatz ist lokal neu.
	BaseVersion *int            `json:"baseVersion"`
	Data        json.RawMessage `json:"data"`
}

type SyncPushRequest struct {
	Changes []SyncPushItem `json:"changes"`
}

type SyncItemError struct {
	Code    string              `json:"code"`
	Message string              `json:"message"`
	Details []apperr.FieldError `json:"details,omitempty"`
}

type SyncPushResult struct {
	Index     int                  `json:"index"`
	Type      *string              `json:"type"`
	ID        *string              `json:"id"`
	Status    string               `json:"status"` // APPLIED | CONFLICT | REJECTED
	Version   *int                 `json:"version"`
	ChangeSeq *int64               `json:"changeSeq"`
	Record    any                  `json:"record"`
	Conflict  *apperr.ConflictInfo `json:"conflict"`
	Error     *SyncItemError       `json:"error"`
}

type SyncPushResponse struct {
	Results    []SyncPushResult `json:"results"`
	ServerTime string           `json:"serverTime"`
}

type SyncDeviceStatus struct {
	DeviceID       string  `json:"deviceId"`
	LastPullAt     *string `json:"lastPullAt"`
	LastPullCursor *string `json:"lastPullCursor"`
	LastPushAt     *string `json:"lastPushAt"`
}

type SyncStatus struct {
	// Höchste Änderungsnummer dieses Kontos. Ist sie größer als der lokale Cursor, gibt es Neues.
	ServerCursor string            `json:"serverCursor"`
	ServerTime   string            `json:"serverTime"`
	Device       *SyncDeviceStatus `json:"device"`
}

// Sync ist die Grundlage der Synchronisierung zwischen Android-App und Server (docs/SYNC.md).
type Sync struct {
	DB       *store.DB
	Reports  *Reports
	Profiles *Profiles
	Now      func() time.Time
	Log      *slog.Logger
}

// Pull liefert alle Änderungen eines Kontos nach dem Cursor, inklusive Tombstones.
func (s *Sync) Pull(ctx context.Context, p Principal, cursor int64, limit int) (*SyncPullResponse, error) {
	var changes []SyncChange
	hasMore := false
	next := cursor
	err := s.DB.Tx(ctx, func(tx pgx.Tx) error {
		changes = nil
		fetch := limit + 1
		daily, err := store.DailyChangedSince(ctx, tx, p.UserID, cursor, fetch)
		if err != nil {
			return err
		}
		weekly, err := store.WeeklyChangedSince(ctx, tx, p.UserID, cursor, fetch)
		if err != nil {
			return err
		}
		profiles, err := store.ProfilesChangedSince(ctx, tx, p.UserID, cursor, fetch)
		if err != nil {
			return err
		}
		for i := range daily {
			r := &daily[i]
			changes = append(changes, change("DAILY_REPORT", r.ID, r.Version, r.ChangeSeq, r.DeletedAt != nil, r.UpdatedAt, r.DTO()))
		}
		for i := range weekly {
			r := &weekly[i]
			changes = append(changes, change("WEEKLY_REPORT", r.ID, r.Version, r.ChangeSeq, r.DeletedAt != nil, r.UpdatedAt, r.DTO()))
		}
		for i := range profiles {
			r := &profiles[i]
			changes = append(changes, change("PROFILE", r.UserID, r.Version, r.ChangeSeq, false, r.UpdatedAt, r.DTO()))
		}
		sort.Slice(changes, func(i, j int) bool { return changes[i].ChangeSeq < changes[j].ChangeSeq })
		if len(changes) > limit {
			changes, hasMore = changes[:limit], true
		}
		if len(changes) > 0 {
			next = changes[len(changes)-1].ChangeSeq
		}
		if p.DeviceRef != nil {
			return store.MarkDevicePull(ctx, tx, *p.DeviceRef, next)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	if changes == nil {
		changes = []SyncChange{}
	}
	return &SyncPullResponse{Changes: changes, NextCursor: itoa(next), HasMore: hasMore,
		ServerTime: model.FormatTime(s.Now())}, nil
}

// Push verarbeitet lokale Änderungen. Jede Änderung wird einzeln und atomar angewendet; Konflikte
// werden gemeldet und niemals stillschweigend überschrieben.
func (s *Sync) Push(ctx context.Context, p Principal, req SyncPushRequest) (*SyncPushResponse, error) {
	if req.Changes == nil {
		return nil, apperr.Validation([]apperr.FieldError{{Field: "changes", Issue: "required"}})
	}
	if len(req.Changes) > MaxPushItems {
		return nil, apperr.Validation([]apperr.FieldError{{Field: "changes", Issue: "too_many:max=100"}})
	}
	results := make([]SyncPushResult, 0, len(req.Changes))
	conflicts := 0
	for i, item := range req.Changes {
		res, err := s.applyItem(ctx, p, i, item)
		if err != nil {
			return nil, err // technischer Fehler (z. B. Datenbank) – nicht Teil der Fachlogik
		}
		if res.Status == "CONFLICT" {
			conflicts++
		}
		results = append(results, res)
	}
	if p.DeviceRef != nil {
		if err := store.MarkDevicePush(ctx, s.DB.Pool, *p.DeviceRef); err != nil {
			return nil, err
		}
	}
	if conflicts > 0 {
		s.Log.Info("Sync-Push mit Konflikten", "user_id", p.UserID, "conflicts", conflicts)
	}
	return &SyncPushResponse{Results: results, ServerTime: model.FormatTime(s.Now())}, nil
}

func (s *Sync) Status(ctx context.Context, p Principal) (*SyncStatus, error) {
	cursor, err := store.ServerCursor(ctx, s.DB.Pool, p.UserID)
	if err != nil {
		return nil, err
	}
	out := &SyncStatus{ServerCursor: itoa(cursor), ServerTime: model.FormatTime(s.Now())}
	if p.DeviceRef != nil {
		d, err := store.FindDeviceByRef(ctx, s.DB.Pool, p.UserID, *p.DeviceRef)
		if err != nil {
			return nil, err
		}
		if d != nil {
			ds := &SyncDeviceStatus{DeviceID: d.DeviceID.String(), LastPullAt: model.FormatTimePtr(d.LastPullAt),
				LastPushAt: model.FormatTimePtr(d.LastPushAt)}
			if d.LastPullCursor != nil {
				c := itoa(*d.LastPullCursor)
				ds.LastPullCursor = &c
			}
			out.Device = ds
		}
	}
	return out, nil
}

func (s *Sync) applyItem(ctx context.Context, p Principal, index int, item SyncPushItem) (SyncPushResult, error) {
	base := SyncPushResult{Index: index, Type: item.Type, ID: item.ID}
	reject := func(code, msg string, details []apperr.FieldError) (SyncPushResult, error) {
		base.Status = "REJECTED"
		base.Error = &SyncItemError{Code: code, Message: msg, Details: details}
		return base, nil
	}

	v := validate.New()
	typ, _ := v.Enum("type", item.Type, syncTypes, "")
	op, _ := v.Enum("operation", item.Operation, syncOperations, "")
	v.Check(item.Type != nil, "type", "required")
	v.Check(item.Operation != nil, "operation", "required")
	id, _ := v.UUID("id", item.ID, true)
	if item.BaseVersion != nil {
		v.Int("baseVersion", item.BaseVersion, 1, 1<<31-1, 0, false)
	}
	if !v.OK() {
		return reject(apperr.CodeValidationFailed, "Die Eingabedaten sind ungültig.", v.Errors())
	}
	if op == "DELETE" && item.BaseVersion == nil {
		return reject(apperr.CodeValidationFailed, "Die Eingabedaten sind ungültig.",
			[]apperr.FieldError{{Field: "baseVersion", Issue: "required"}})
	}

	var err error
	switch typ {
	case "DAILY_REPORT":
		var out Outcome[model.DailyReport]
		out, err = applyVersioned(ctx, s.Reports.Daily, p, op, id, item, func(r DailyReportRequest, v *validate.V) model.DailyValues { return r.Values(v) })
		if err == nil {
			return toResult(base, out, func(r *model.DailyReport) (int, int64, bool, any) {
				return r.Version, r.ChangeSeq, r.DeletedAt != nil, r.DTO()
			}), nil
		}
	case "WEEKLY_REPORT":
		var out Outcome[model.WeeklyReport]
		out, err = applyVersioned(ctx, s.Reports.Weekly, p, op, id, item, func(r WeeklyReportRequest, v *validate.V) model.WeeklyValues { return r.Values(v) })
		if err == nil {
			return toResult(base, out, func(r *model.WeeklyReport) (int, int64, bool, any) {
				return r.Version, r.ChangeSeq, r.DeletedAt != nil, r.DTO()
			}), nil
		}
	case "PROFILE":
		if id != p.UserID {
			return reject(apperr.CodeNotFound, "Datensatz existiert nicht auf dem Server.", nil)
		}
		if op == "DELETE" {
			return reject(apperr.CodeValidationFailed, "Das Profil kann nicht gelöscht werden.",
				[]apperr.FieldError{{Field: "operation", Issue: "profile_cannot_be_deleted"}})
		}
		if item.BaseVersion == nil {
			return reject(apperr.CodeValidationFailed, "Die Eingabedaten sind ungültig.",
				[]apperr.FieldError{{Field: "baseVersion", Issue: "required"}})
		}
		var req ProfileRequest
		if err := decodeData(item.Data, &req); err != nil {
			return rejectErr(base, err), nil
		}
		pv := validate.New()
		values := req.Values(pv)
		if err := pv.Err(); err != nil {
			return rejectErr(base, err), nil
		}
		out, err := s.Profiles.Update(ctx, p.UserID, *item.BaseVersion, values)
		if err != nil {
			return base, err
		}
		return toResult(base, out, func(r *model.Profile) (int, int64, bool, any) {
			return r.Version, r.ChangeSeq, false, r.DTO()
		}), nil
	}
	var appErr *apperr.Error
	if errors.As(err, &appErr) {
		return rejectErr(base, err), nil
	}
	return base, err
}

// applyVersioned dekodiert und validiert die Daten und wendet die Operation an.
func applyVersioned[Req any, V any, R any](ctx context.Context, w VersionedWriter[V, R], p Principal, op string,
	id uuid.UUID, item SyncPushItem, values func(Req, *validate.V) V) (Outcome[R], error) {
	if op == "DELETE" {
		return w.Delete(ctx, p.UserID, id, *item.BaseVersion, p.DeviceRef)
	}
	var req Req
	if err := decodeData(item.Data, &req); err != nil {
		return Outcome[R]{}, err
	}
	v := validate.New()
	vals := values(req, v)
	if err := v.Err(); err != nil {
		return Outcome[R]{}, err
	}
	if item.BaseVersion == nil {
		return w.Create(ctx, p.UserID, id, vals, p.DeviceRef)
	}
	return w.Update(ctx, p.UserID, id, *item.BaseVersion, vals, p.DeviceRef)
}

func decodeData(raw json.RawMessage, target any) error {
	if len(raw) == 0 || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return apperr.Validation([]apperr.FieldError{{Field: "data", Issue: "required"}})
	}
	if err := json.Unmarshal(raw, target); err != nil {
		return apperr.New(400, apperr.CodeInvalidRequestBody, "Die Daten haben eine ungültige Struktur.")
	}
	return nil
}

func rejectErr(base SyncPushResult, err error) SyncPushResult {
	var e *apperr.Error
	errors.As(err, &e)
	base.Status = "REJECTED"
	base.Error = &SyncItemError{Code: e.Code, Message: e.Message, Details: e.Details}
	return base
}

func toResult[R any](base SyncPushResult, out Outcome[R], meta func(*R) (int, int64, bool, any)) SyncPushResult {
	switch out.Kind {
	case Applied:
		version, seq, deleted, dto := meta(out.Record)
		base.Status, base.Version, base.ChangeSeq = "APPLIED", &version, &seq
		if !deleted {
			base.Record = dto
		}
	case Conflicted:
		base.Status = "CONFLICT"
		info := &apperr.ConflictInfo{Reason: out.Reason}
		if out.Record != nil {
			version, _, deleted, dto := meta(out.Record)
			info.ServerVersion = &version
			if !deleted {
				info.ServerRecord = dto
			}
		}
		base.Conflict = info
	default:
		base.Status = "REJECTED"
		base.Error = &SyncItemError{Code: apperr.CodeNotFound, Message: "Datensatz existiert nicht auf dem Server."}
	}
	return base
}

func change(typ string, id uuid.UUID, version int, seq int64, deleted bool, updated time.Time, dto any) SyncChange {
	c := SyncChange{Type: typ, ID: id.String(), Version: version, ChangeSeq: seq, Deleted: deleted,
		UpdatedAt: model.FormatTime(updated)}
	if !deleted {
		c.Data = dto
	}
	return c
}

func itoa(n int64) string {
	b, _ := json.Marshal(n)
	return string(b)
}
