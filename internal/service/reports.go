package service

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"berichtly-server/internal/apperr"
	"berichtly-server/internal/model"
	"berichtly-server/internal/store"
	"berichtly-server/internal/validate"
)

// Feldgrenzen (siehe docs/API.md).
const (
	DailyTextMax     = 5000
	DailyNoteMax     = 2000
	OrderIndexMax    = 10000
	WeeklyContentMax = 50000
)

// DailyReportRequest ist der Inhalt eines Tagesberichts für Erstellen (optional mit Client-ID) und
// Ersetzen (mit `version` als Basisversion). Felder sind Zeiger, damit fehlende Werte erkannt werden.
type DailyReportRequest struct {
	ID         *string `json:"id"`
	Version    *int    `json:"version"`
	Date       *string `json:"date"`
	Text       *string `json:"text"`
	Note       *string `json:"note"`
	OrderIndex *int    `json:"orderIndex"`
	Status     *string `json:"status"`
}

func (r DailyReportRequest) Values(v *validate.V) model.DailyValues {
	date, _ := v.Date("date", r.Date, true)
	text, _ := v.Text("text", r.Text, validate.TextOpts{Max: DailyTextMax, Required: true, NotBlank: true})
	note, _ := v.Text("note", r.Note, validate.TextOpts{Max: DailyNoteMax})
	order, _ := v.Int("orderIndex", r.OrderIndex, 0, OrderIndexMax, 0, false)
	status, _ := v.Enum("status", r.Status, model.ReportStatuses, string(model.StatusDraft))
	out := model.DailyValues{Text: text, Note: note, OrderIndex: order, Status: model.ReportStatus(status)}
	if date != nil {
		out.Date = *date
	}
	return out
}

// WeeklyReportRequest ist der Inhalt eines Wochenberichts.
type WeeklyReportRequest struct {
	ID          *string `json:"id"`
	Version     *int    `json:"version"`
	WeekStart   *string `json:"weekStart"` // Montag der Woche
	Content     *string `json:"content"`
	Status      *string `json:"status"`
	GeneratedAt *string `json:"generatedAt"`
}

func (r WeeklyReportRequest) Values(v *validate.V) model.WeeklyValues {
	start, ok := v.Date("weekStart", r.WeekStart, true)
	if ok && start != nil && start.Weekday() != time.Monday {
		v.Add("weekStart", "must_be_monday")
	}
	content, _ := v.Text("content", r.Content, validate.TextOpts{Max: WeeklyContentMax})
	status, _ := v.Enum("status", r.Status, model.ReportStatuses, string(model.StatusDraft))
	generated, _ := v.Timestamp("generatedAt", r.GeneratedAt)
	out := model.WeeklyValues{Content: content, Status: model.ReportStatus(status), GeneratedAt: generated}
	if start != nil {
		out.Week = model.WeekContaining(*start)
	}
	return out
}

// Reports verwaltet Tages- und Wochenberichte.
type Reports struct {
	DB     *store.DB
	Daily  VersionedWriter[model.DailyValues, model.DailyReport]
	Weekly VersionedWriter[model.WeeklyValues, model.WeeklyReport]
	Now    func() time.Time
}

func NewReports(db *store.DB, now func() time.Time) *Reports {
	return &Reports{
		DB:     db,
		Daily:  VersionedWriter[model.DailyValues, model.DailyReport]{DB: db, Store: store.DailyStore{}},
		Weekly: VersionedWriter[model.WeeklyValues, model.WeeklyReport]{DB: db, Store: store.WeeklyStore{}},
		Now:    now,
	}
}

func (s *Reports) GetDaily(ctx context.Context, userID, id uuid.UUID) (*model.DailyReport, error) {
	r, err := store.FindActiveDaily(ctx, s.DB.Pool, userID, id)
	if err == nil && r == nil {
		return nil, apperr.NotFound("Tagesbericht")
	}
	return r, err
}

func (s *Reports) ListDaily(ctx context.Context, userID uuid.UUID, f store.ReportFilter) ([]model.DailyReport, int64, error) {
	return store.ListDaily(ctx, s.DB.Pool, userID, f)
}

func (s *Reports) GetWeekly(ctx context.Context, userID, id uuid.UUID) (*model.WeeklyReport, error) {
	r, err := store.FindActiveWeekly(ctx, s.DB.Pool, userID, id)
	if err == nil && r == nil {
		return nil, apperr.NotFound("Wochenbericht")
	}
	return r, err
}

func (s *Reports) ListWeekly(ctx context.Context, userID uuid.UUID, f store.ReportFilter) ([]model.WeeklyReport, int64, error) {
	return store.ListWeekly(ctx, s.DB.Pool, userID, f)
}

// WeekOverview ist eine Woche (Montag–Sonntag) mit Tagesberichten und Wochenbericht.
type WeekOverview struct {
	Week     model.IsoWeek
	Timezone string
	Daily    []model.DailyReport
	Weekly   *model.WeeklyReport
}

// Week liefert die Woche, die date enthält. Ohne Datum wird "heute" in der Zeitzone des Benutzers
// bestimmt – nie in der Zeitzone des Servers.
func (s *Reports) Week(ctx context.Context, userID uuid.UUID, date *model.Date) (*WeekOverview, error) {
	var out WeekOverview
	err := s.DB.Tx(ctx, func(tx pgx.Tx) error {
		user, err := store.FindUserByID(ctx, tx, userID)
		if err != nil {
			return err
		}
		if user == nil {
			return apperr.NotFound("Konto")
		}
		loc, err := time.LoadLocation(user.Timezone)
		if err != nil {
			loc = time.UTC
		}
		day := model.DateOf(s.Now().In(loc))
		if date != nil {
			day = *date
		}
		out.Week = model.WeekContaining(day)
		out.Timezone = user.Timezone
		if out.Daily, err = store.ListDailyInRange(ctx, tx, userID, out.Week.Start, out.Week.End()); err != nil {
			return err
		}
		out.Weekly, err = store.FindActiveWeeklyForWeek(ctx, tx, userID, out.Week.Start)
		return err
	})
	return &out, err
}
