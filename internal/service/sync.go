package service

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"regexp"
	"sort"
	"strconv"
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
	syncTypes        = []string{"DAILY_REPORT", "WEEKLY_REPORT", "PROFILE"}
	syncOperations   = []string{"UPSERT", "DELETE"}
	syncErrorPattern = regexp.MustCompile(`^[A-Z0-9_]{1,64}$`)
)

// SyncChange ist eine Änderung auf dem Server. Gelöschte Datensätze erscheinen als Tombstone
// (deleted = true, data = null).
type SyncChange struct {
	Type      string `json:"type"`
	ID        string `json:"id"`
	Version   int    `json:"version"`
	ChangeSeq int64  `json:"changeSeq"`
	Deleted   bool   `json:"deleted"`
	UpdatedAt string `json:"updatedAt"` // Serverzeit
	// true, wenn die Änderung durch eine Operation derselben Sync-Anfrage entstanden ist
	// (das Gerät kennt den Inhalt bereits). Nur bei POST /sync gesetzt.
	Echo bool `json:"echo,omitempty"`
	Data any  `json:"data"`
}

type SyncPullResponse struct {
	Changes []SyncChange `json:"changes"`
	// Für den nächsten Abruf als `cursor` übergeben – erst nach erfolgreicher lokaler Übernahme speichern.
	NextCursor string `json:"nextCursor"`
	HasMore    bool   `json:"hasMore"`
	ServerTime string `json:"serverTime"`
}

type SyncPushItem struct {
	// Eindeutige ID dieser Operation (vom Gerät erzeugt, bei Wiederholung identisch). Empfohlen;
	// ermöglicht exakt-einmalige Verarbeitung auch bei verlorenen Antworten.
	OperationID *string `json:"operationId"`
	Type        *string `json:"type"`
	Operation   *string `json:"operation"`
	ID          *string `json:"id"`
	// Version, auf der die lokale Änderung basiert. null = Datensatz ist lokal neu.
	BaseVersion *int            `json:"baseVersion"`
	Data        json.RawMessage `json:"data"`
	ClientInfo
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
	Index       int                  `json:"index"`
	OperationID *string              `json:"operationId"`
	Type        *string              `json:"type"`
	ID          *string              `json:"id"`
	Status      string               `json:"status"` // APPLIED | CONFLICT | REJECTED
	Version     *int                 `json:"version"`
	ChangeSeq   *int64               `json:"changeSeq"`
	Record      any                  `json:"record"`
	Conflict    *apperr.ConflictInfo `json:"conflict"`
	Error       *SyncItemError       `json:"error"`
	// true, wenn diese Operation bereits früher verarbeitet wurde und nur ihr Ergebnis geliefert wird.
	Replayed bool `json:"replayed"`
}

type SyncPushResponse struct {
	Results    []SyncPushResult `json:"results"`
	ServerTime string           `json:"serverTime"`
}

// SyncRequest kombiniert Hochladen und Herunterladen in einem Vorgang (POST /sync).
type SyncRequest struct {
	Cursor  *string        `json:"cursor"`
	Limit   *int           `json:"limit"`
	Changes []SyncPushItem `json:"changes"`
}

type SyncResponse struct {
	Push       SyncPushResponse  `json:"push"`
	Pull       SyncPullResponse  `json:"pull"`
	Device     *SyncDeviceStatus `json:"device"`
	ServerTime string            `json:"serverTime"`
}

// SyncCompleteRequest meldet das Ergebnis eines Synchronisationsvorgangs.
type SyncCompleteRequest struct {
	Result              *string `json:"result"` // SUCCESS | FAILED
	Cursor              *string `json:"cursor"` // erfolgreich übernommener Cursor (Pflicht bei SUCCESS)
	UnresolvedConflicts *int    `json:"unresolvedConflicts"`
	ErrorCode           *string `json:"errorCode"` // bei FAILED, z. B. NETWORK_ERROR
}

type SyncDeviceStatus struct {
	DeviceID             string  `json:"deviceId"`
	SyncStatus           string  `json:"syncStatus"` // NEVER | SUCCESS | FAILED | CONFLICT
	LastSyncAt           *string `json:"lastSyncAt"`
	LastSuccessfulCursor *string `json:"lastSuccessfulCursor"`
	LastSyncStartedAt    *string `json:"lastSyncStartedAt"`
	LastFailedSyncAt     *string `json:"lastFailedSyncAt"`
	LastSyncErrorCode    *string `json:"lastSyncErrorCode"`
	UnresolvedConflicts  int     `json:"unresolvedConflicts"`
	LastPullAt           *string `json:"lastPullAt"`
	LastPullCursor       *string `json:"lastPullCursor"`
	LastPushAt           *string `json:"lastPushAt"`
}

type SyncStatus struct {
	// Höchste Änderungsnummer dieses Kontos. Ist sie größer als der lokale Cursor, gibt es Neues.
	ServerCursor string `json:"serverCursor"`
	// Kleinster noch gültiger Cursor (> 0). Ältere Cursor erfordern eine vollständige Neusynchronisierung.
	MinValidCursor string            `json:"minValidCursor"`
	ServerTime     string            `json:"serverTime"`
	Device         *SyncDeviceStatus `json:"device"`
}

// Sync ist die Grundlage der Synchronisierung zwischen Android-App und Server (docs/SYNC.md).
type Sync struct {
	DB       *store.DB
	Reports  *Reports
	Profiles *Profiles
	Now      func() time.Time
	Log      *slog.Logger
}

// ParseCursor prüft einen Cursor-Wert ("0" = alles).
func ParseCursor(raw *string) (int64, error) {
	if raw == nil || *raw == "" {
		return 0, nil
	}
	c, err := strconv.ParseInt(*raw, 10, 64)
	if err != nil || c < 0 {
		return 0, apperr.BadParameter("cursor", "invalid_cursor")
	}
	return c, nil
}

// checkCursor erkennt Cursor, die älter als bereits bereinigte Tombstones sind.
func (s *Sync) checkCursor(ctx context.Context, cursor int64) error {
	if cursor == 0 {
		return nil
	}
	min, err := store.MinValidCursor(ctx, s.DB.Pool)
	if err != nil {
		return err
	}
	if cursor < min {
		return apperr.New(http.StatusGone, apperr.CodeSyncCursorExpired,
			"Der Synchronisationsstand ist zu alt. Bitte vollständig neu synchronisieren (cursor=0).")
	}
	return nil
}

// Pull liefert alle Änderungen eines Kontos nach dem Cursor, inklusive Tombstones.
func (s *Sync) Pull(ctx context.Context, p Principal, cursor int64, limit int) (*SyncPullResponse, error) {
	if err := s.checkCursor(ctx, cursor); err != nil {
		return nil, err
	}
	return s.pull(ctx, p, cursor, limit, nil)
}

func (s *Sync) pull(ctx context.Context, p Principal, cursor int64, limit int, echo map[string]int) (*SyncPullResponse, error) {
	var changes []SyncChange
	hasMore := false
	next := cursor
	// Ein einziger Snapshot über alle Tabellen: Sonst könnte eine zwischen zwei Abfragen committete
	// Änderung mit niedrigerer Nummer übersprungen werden.
	err := s.DB.Snapshot(ctx, func(tx pgx.Tx) error {
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
		return nil
	})
	if err != nil {
		return nil, err
	}
	for i := range changes {
		if v, ok := echo[changes[i].ID]; ok && v == changes[i].Version {
			changes[i].Echo = true
		}
	}
	if p.DeviceRef != nil {
		if err := store.MarkDevicePull(ctx, s.DB.Pool, *p.DeviceRef, next); err != nil {
			return nil, err
		}
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
	return s.push(ctx, p, req.Changes)
}

func (s *Sync) push(ctx context.Context, p Principal, items []SyncPushItem) (*SyncPushResponse, error) {
	if len(items) > MaxPushItems {
		return nil, apperr.Validation([]apperr.FieldError{{Field: "changes", Issue: "too_many:max=100"}})
	}
	results := make([]SyncPushResult, 0, len(items))
	conflicts := 0
	for i, item := range items {
		res, err := s.applyItem(ctx, p, i, item)
		if err != nil {
			return nil, err // technischer Fehler (z. B. Datenbank) – nicht Teil der Fachlogik
		}
		if res.Status == "CONFLICT" {
			conflicts++
		}
		results = append(results, res)
	}
	if p.DeviceRef != nil && len(items) > 0 {
		if err := store.MarkDevicePush(ctx, s.DB.Pool, *p.DeviceRef); err != nil {
			return nil, err
		}
	}
	if conflicts > 0 {
		s.Log.Info("Sync-Push mit Konflikten", "user_id", p.UserID, "conflicts", conflicts)
	}
	return &SyncPushResponse{Results: results, ServerTime: model.FormatTime(s.Now())}, nil
}

// Sync führt einen vollständigen Synchronisationsschritt aus: zuerst lokale Änderungen anwenden,
// danach Serveränderungen ab dem Cursor liefern. Eigene Änderungen dieses Schritts sind als
// "echo" markiert.
func (s *Sync) Sync(ctx context.Context, p Principal, req SyncRequest) (*SyncResponse, error) {
	cursor, err := ParseCursor(req.Cursor)
	if err != nil {
		return nil, err
	}
	limit := DefaultPullLimit
	if req.Limit != nil {
		if *req.Limit < 1 || *req.Limit > MaxPullLimit {
			return nil, apperr.Validation([]apperr.FieldError{{Field: "limit", Issue: "out_of_range:1..500"}})
		}
		limit = *req.Limit
	}
	if err := s.checkCursor(ctx, cursor); err != nil {
		return nil, err
	}
	if p.DeviceRef != nil {
		if err := store.MarkSyncStarted(ctx, s.DB.Pool, *p.DeviceRef); err != nil {
			return nil, err
		}
	}
	pushed, err := s.push(ctx, p, req.Changes)
	if err != nil {
		return nil, err
	}
	echo := map[string]int{}
	for _, r := range pushed.Results {
		if r.Status == "APPLIED" && r.ID != nil && r.Version != nil {
			echo[*r.ID] = *r.Version
		}
	}
	pulled, err := s.pull(ctx, p, cursor, limit, echo)
	if err != nil {
		return nil, err
	}
	resp := &SyncResponse{Push: *pushed, Pull: *pulled, ServerTime: model.FormatTime(s.Now())}
	if p.DeviceRef != nil {
		if resp.Device, err = s.deviceStatus(ctx, p); err != nil {
			return nil, err
		}
	}
	return resp, nil
}

// Complete speichert das Ergebnis eines Synchronisationsvorgangs für das aktuelle Gerät.
// Der Server kann nicht selbst wissen, ob das Gerät alle Daten lokal übernommen hat; deshalb
// meldet das Gerät den Abschluss. Ein fehlgeschlagener Vorgang wird nie als Erfolg gespeichert.
func (s *Sync) Complete(ctx context.Context, p Principal, req SyncCompleteRequest) (*SyncDeviceStatus, error) {
	if p.DeviceRef == nil {
		return nil, apperr.New(http.StatusConflict, apperr.CodeDeviceRequired,
			"Diese Sitzung ist keinem Gerät zugeordnet. Bitte zuerst POST /api/v1/devices aufrufen.")
	}
	v := validate.New()
	result, _ := v.Enum("result", req.Result, []string{"SUCCESS", "FAILED"}, "")
	v.Check(req.Result != nil, "result", "required")
	conflicts, _ := v.Int("unresolvedConflicts", req.UnresolvedConflicts, 0, 100000, 0, false)
	var cursor *int64
	if result == "SUCCESS" {
		if req.Cursor == nil {
			v.Add("cursor", "required")
		} else if c, err := ParseCursor(req.Cursor); err != nil {
			v.Add("cursor", "invalid_cursor")
		} else {
			cursor = &c
		}
	}
	if req.ErrorCode != nil && !syncErrorPattern.MatchString(*req.ErrorCode) {
		v.Add("errorCode", "invalid_value:[A-Z0-9_]{1,64}")
	}
	if err := v.Err(); err != nil {
		return nil, err
	}
	if cursor != nil {
		serverCursor, err := store.ServerCursor(ctx, s.DB.Pool, p.UserID)
		if err != nil {
			return nil, err
		}
		if *cursor > serverCursor {
			return nil, apperr.Validation([]apperr.FieldError{{Field: "cursor", Issue: "beyond_server_cursor"}})
		}
	}
	status := model.SyncFailed
	if result == "SUCCESS" {
		status = model.SyncSuccess
		if conflicts > 0 {
			status = model.SyncConflict
		}
	}
	if err := store.CompleteSync(ctx, s.DB.Pool, *p.DeviceRef, status, cursor, conflicts, req.ErrorCode); err != nil {
		return nil, err
	}
	return s.deviceStatus(ctx, p)
}

func (s *Sync) Status(ctx context.Context, p Principal) (*SyncStatus, error) {
	cursor, err := store.ServerCursor(ctx, s.DB.Pool, p.UserID)
	if err != nil {
		return nil, err
	}
	min, err := store.MinValidCursor(ctx, s.DB.Pool)
	if err != nil {
		return nil, err
	}
	out := &SyncStatus{ServerCursor: itoa(cursor), MinValidCursor: itoa(min), ServerTime: model.FormatTime(s.Now())}
	if p.DeviceRef != nil {
		if out.Device, err = s.deviceStatus(ctx, p); err != nil {
			return nil, err
		}
	}
	return out, nil
}

func (s *Sync) deviceStatus(ctx context.Context, p Principal) (*SyncDeviceStatus, error) {
	d, err := store.FindDeviceByRef(ctx, s.DB.Pool, p.UserID, *p.DeviceRef)
	if err != nil || d == nil {
		return nil, err
	}
	optCursor := func(c *int64) *string {
		if c == nil {
			return nil
		}
		s := itoa(*c)
		return &s
	}
	return &SyncDeviceStatus{
		DeviceID:             d.DeviceID.String(),
		SyncStatus:           string(d.SyncStatus),
		LastSyncAt:           model.FormatTimePtr(d.LastSuccessfulSyncAt),
		LastSuccessfulCursor: optCursor(d.LastSuccessfulCursor),
		LastSyncStartedAt:    model.FormatTimePtr(d.LastSyncStartedAt),
		LastFailedSyncAt:     model.FormatTimePtr(d.LastFailedSyncAt),
		LastSyncErrorCode:    d.LastSyncErrorCode,
		UnresolvedConflicts:  d.UnresolvedConflicts,
		LastPullAt:           model.FormatTimePtr(d.LastPullAt),
		LastPullCursor:       optCursor(d.LastPullCursor),
		LastPushAt:           model.FormatTimePtr(d.LastPushAt),
	}, nil
}

// storedResult ist das gespeicherte (inhaltsfreie) Ergebnis einer Operation für Wiederholungen.
type storedResult struct {
	Status        string                 `json:"status"`
	Version       *int                   `json:"version,omitempty"`
	ChangeSeq     *int64                 `json:"changeSeq,omitempty"`
	ConflictCause *apperr.ConflictReason `json:"conflictReason,omitempty"`
	ServerVersion *int                   `json:"serverVersion,omitempty"`
}

// prepared ist eine validierte Operation, bereit zur Ausführung in einer Transaktion.
type prepared struct {
	typ, op string
	id      uuid.UUID
	opID    *uuid.UUID
	hash    []byte
	run     func(tx pgx.Tx) (SyncPushResult, error)
}

func (s *Sync) applyItem(ctx context.Context, p Principal, index int, item SyncPushItem) (SyncPushResult, error) {
	base := SyncPushResult{Index: index, OperationID: item.OperationID, Type: item.Type, ID: item.ID}
	op, err := s.prepare(ctx, p, item, base)
	if err != nil {
		var e *apperr.Error
		if errors.As(err, &e) {
			return rejectErr(base, err), nil
		}
		return base, err
	}

	var result SyncPushResult
	err = s.DB.Tx(ctx, func(tx pgx.Tx) error {
		if op.opID != nil {
			// Sperre vorab, damit gleichzeitige Wiederholungen derselben Operation nacheinander laufen.
			if err := store.LockUser(ctx, tx, p.UserID); err != nil {
				return err
			}
			stored, err := store.FindOperation(ctx, tx, p.UserID, *op.opID)
			if err != nil {
				return err
			}
			if stored != nil {
				result = replay(base, stored, op.hash)
				return nil
			}
		}
		var err error
		if result, err = op.run(tx); err != nil {
			return err
		}
		if op.opID != nil && (result.Status == "APPLIED" || result.Status == "CONFLICT") {
			sr := storedResult{Status: result.Status, Version: result.Version, ChangeSeq: result.ChangeSeq}
			if result.Conflict != nil {
				reason := result.Conflict.Reason
				sr.ConflictCause, sr.ServerVersion = &reason, result.Conflict.ServerVersion
			}
			return store.InsertOperation(ctx, tx, p.UserID, *op.opID, p.DeviceRef, op.typ, op.id, op.hash, sr)
		}
		return nil
	})
	return result, err
}

// prepare validiert eine Operation vollständig, bevor eine Transaktion begonnen wird.
func (s *Sync) prepare(ctx context.Context, p Principal, item SyncPushItem, base SyncPushResult) (*prepared, error) {
	v := validate.New()
	v.Check(item.Type != nil, "type", "required")
	v.Check(item.Operation != nil, "operation", "required")
	typ, _ := v.Enum("type", item.Type, syncTypes, "")
	opName, _ := v.Enum("operation", item.Operation, syncOperations, "")
	id, _ := v.UUID("id", item.ID, true)
	var opID *uuid.UUID
	if item.OperationID != nil {
		if parsed, ok := v.UUID("operationId", item.OperationID, true); ok {
			opID = &parsed
		}
	}
	if item.BaseVersion != nil {
		v.Int("baseVersion", item.BaseVersion, 1, 1<<31-1, 0, false)
	}
	if err := v.Err(); err != nil {
		return nil, err
	}
	if opName == "DELETE" && item.BaseVersion == nil {
		return nil, apperr.Validation([]apperr.FieldError{{Field: "baseVersion", Issue: "required"}})
	}
	meta := item.ClientInfo.Meta(v, p.DeviceRef, opID)
	if err := v.Err(); err != nil {
		return nil, err
	}
	pr := &prepared{typ: typ, op: opName, id: id, opID: opID, hash: requestHash(item)}

	switch typ {
	case "DAILY_REPORT":
		run, err := prepareVersioned(ctx, s.Reports.Daily, p, opName, id, item, meta,
			func(r DailyReportRequest, v *validate.V) model.DailyValues { return r.Values(v) },
			func(r *model.DailyReport) (int, int64, bool, any) {
				return r.Version, r.ChangeSeq, r.DeletedAt != nil, r.DTO()
			})
		pr.run = func(tx pgx.Tx) (SyncPushResult, error) { return run(tx, base) }
		return pr, err
	case "WEEKLY_REPORT":
		run, err := prepareVersioned(ctx, s.Reports.Weekly, p, opName, id, item, meta,
			func(r WeeklyReportRequest, v *validate.V) model.WeeklyValues { return r.Values(v) },
			func(r *model.WeeklyReport) (int, int64, bool, any) {
				return r.Version, r.ChangeSeq, r.DeletedAt != nil, r.DTO()
			})
		pr.run = func(tx pgx.Tx) (SyncPushResult, error) { return run(tx, base) }
		return pr, err
	default: // PROFILE
		if id != p.UserID {
			return nil, apperr.New(http.StatusNotFound, apperr.CodeNotFound, "Datensatz existiert nicht auf dem Server.")
		}
		if opName == "DELETE" {
			return nil, apperr.Validation([]apperr.FieldError{{Field: "operation", Issue: "profile_cannot_be_deleted"}})
		}
		if item.BaseVersion == nil {
			return nil, apperr.Validation([]apperr.FieldError{{Field: "baseVersion", Issue: "required"}})
		}
		var req ProfileRequest
		if err := decodeData(item.Data, &req); err != nil {
			return nil, err
		}
		pv := validate.New()
		values := req.Values(pv)
		if err := pv.Err(); err != nil {
			return nil, err
		}
		pr.run = func(tx pgx.Tx) (SyncPushResult, error) {
			out, err := s.Profiles.UpdateTx(ctx, tx, p.UserID, *item.BaseVersion, values)
			if err != nil {
				return base, err
			}
			return toResult(base, out, func(r *model.Profile) (int, int64, bool, any) {
				return r.Version, r.ChangeSeq, false, r.DTO()
			}), nil
		}
		return pr, nil
	}
}

// prepareVersioned dekodiert und validiert die Daten und liefert die Ausführung als Funktion.
func prepareVersioned[Req any, V any, R any](ctx context.Context, w VersionedWriter[V, R], p Principal, op string, id uuid.UUID,
	item SyncPushItem, meta model.WriteMeta, values func(Req, *validate.V) V,
	describe func(*R) (int, int64, bool, any)) (func(pgx.Tx, SyncPushResult) (SyncPushResult, error), error) {
	if op == "DELETE" {
		return func(tx pgx.Tx, base SyncPushResult) (SyncPushResult, error) {
			out, err := w.DeleteTx(ctx, tx, p.UserID, id, *item.BaseVersion, meta)
			return toResult(base, out, describe), err
		}, nil
	}
	var req Req
	if err := decodeData(item.Data, &req); err != nil {
		return nil, err
	}
	v := validate.New()
	vals := values(req, v)
	if err := v.Err(); err != nil {
		return nil, err
	}
	if item.BaseVersion == nil {
		return func(tx pgx.Tx, base SyncPushResult) (SyncPushResult, error) {
			out, err := w.CreateTx(ctx, tx, p.UserID, id, vals, meta)
			return toResult(base, out, describe), err
		}, nil
	}
	return func(tx pgx.Tx, base SyncPushResult) (SyncPushResult, error) {
		out, err := w.UpdateTx(ctx, tx, p.UserID, id, *item.BaseVersion, vals, meta)
		return toResult(base, out, describe), err
	}, nil
}

// replay liefert das gespeicherte Ergebnis einer bereits verarbeiteten Operation.
func replay(base SyncPushResult, stored *store.StoredOperation, hash []byte) SyncPushResult {
	if !bytes.Equal(stored.RequestHash, hash) {
		base.Status = "REJECTED"
		base.Error = &SyncItemError{Code: apperr.CodeOperationIDReused,
			Message: "Diese operationId wurde bereits für eine andere Änderung verwendet."}
		return base
	}
	var sr storedResult
	_ = json.Unmarshal(stored.Result, &sr)
	base.Status, base.Version, base.ChangeSeq, base.Replayed = sr.Status, sr.Version, sr.ChangeSeq, true
	if sr.ConflictCause != nil {
		base.Conflict = &apperr.ConflictInfo{Reason: *sr.ConflictCause, ServerVersion: sr.ServerVersion}
	}
	return base
}

// requestHash identifiziert den Inhalt einer Operation, um Wiederverwendung einer operationId
// für eine andere Änderung zu erkennen.
func requestHash(item SyncPushItem) []byte {
	var compact bytes.Buffer
	if len(item.Data) > 0 {
		_ = json.Compact(&compact, item.Data)
	}
	canonical, _ := json.Marshal(struct {
		Type, Operation, ID *string
		BaseVersion         *int
		Data                string
		ClientInfo
	}{item.Type, item.Operation, item.ID, item.BaseVersion, compact.String(), item.ClientInfo})
	sum := sha256.Sum256(canonical)
	return sum[:]
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

func itoa(n int64) string { return strconv.FormatInt(n, 10) }
