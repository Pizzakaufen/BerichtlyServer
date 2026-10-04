package store

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"berichtly-server/internal/model"
)

// ---------------------------------------------------------------------------
// Profil
// ---------------------------------------------------------------------------

const profileColumns = `user_id, name, profession, company, department, trainer_name, training_start,
	training_end, writing_style, version, created_at, updated_at, change_seq`

func scanProfile(row interface{ Scan(...any) error }) (*model.Profile, error) {
	var p model.Profile
	var start, end *time.Time
	var style string
	err := row.Scan(&p.UserID, &p.Values.Name, &p.Values.Profession, &p.Values.Company, &p.Values.Department,
		&p.Values.TrainerName, &start, &end, &style, &p.Version, &p.CreatedAt, &p.UpdatedAt, &p.ChangeSeq)
	if err != nil {
		return nil, err
	}
	p.Values.TrainingStart = datePtr(start)
	p.Values.TrainingEnd = datePtr(end)
	p.Values.WritingStyle = model.WritingStyle(style)
	return &p, nil
}

func InsertEmptyProfile(ctx context.Context, q Querier, userID uuid.UUID) error {
	_, err := q.Exec(ctx, `INSERT INTO user_profiles (user_id) VALUES ($1)`, userID)
	return err
}

func FindProfile(ctx context.Context, q Querier, userID uuid.UUID, forUpdate bool) (*model.Profile, error) {
	sql := `SELECT ` + profileColumns + ` FROM user_profiles WHERE user_id = $1`
	if forUpdate {
		sql += ` FOR UPDATE`
	}
	return nilIfNoRows(scanProfile(q.QueryRow(ctx, sql, userID)))
}

// UpdateProfile ändert nur, wenn die gespeicherte Version expected entspricht (nil = Versionskonflikt).
func UpdateProfile(ctx context.Context, q Querier, userID uuid.UUID, expected int, v model.ProfileValues) (*model.Profile, error) {
	return nilIfNoRows(scanProfile(q.QueryRow(ctx, `
		UPDATE user_profiles SET name = $1, profession = $2, company = $3, department = $4, trainer_name = $5,
			training_start = $6, training_end = $7, writing_style = $8, version = version + 1
		WHERE user_id = $9 AND version = $10
		RETURNING `+profileColumns,
		v.Name, v.Profession, v.Company, v.Department, v.TrainerName,
		dateParam(v.TrainingStart), dateParam(v.TrainingEnd), string(v.WritingStyle), userID, expected)))
}

func ProfilesChangedSince(ctx context.Context, q Querier, userID uuid.UUID, cursor int64, limit int) ([]model.Profile, error) {
	return queryAll(ctx, q, scanProfile, `SELECT `+profileColumns+` FROM user_profiles
		WHERE user_id = $1 AND change_seq > $2 ORDER BY change_seq LIMIT $3`, userID, cursor, limit)
}

// ---------------------------------------------------------------------------
// Gemeinsame Herkunftsspalten (Clientzeit, lokale ID, Geräte, Operation)
// ---------------------------------------------------------------------------

// originColumns liefert die stabilen Geräte-IDs (nicht die internen Referenzen) per Unterabfrage.
const originColumns = `client_updated_at, client_local_id,
	(SELECT d.device_id FROM devices d WHERE d.id = created_by_device_ref),
	(SELECT d.device_id FROM devices d WHERE d.id = last_device_ref),
	last_operation_id`

func originTargets(o *model.Origin) []any {
	return []any{&o.ClientUpdatedAt, &o.ClientLocalID, &o.CreatedByDeviceID, &o.LastDeviceID, &o.LastOperationID}
}

// ---------------------------------------------------------------------------
// Tagesberichte
// ---------------------------------------------------------------------------

const dailyColumns = `id, user_id, report_date, text, note, order_index, status, version,
	created_at, updated_at, deleted_at, change_seq, ` + originColumns

func scanDaily(row interface{ Scan(...any) error }) (*model.DailyReport, error) {
	var r model.DailyReport
	var date time.Time
	var status string
	targets := append([]any{&r.ID, &r.UserID, &date, &r.Values.Text, &r.Values.Note, &r.Values.OrderIndex, &status,
		&r.Version, &r.CreatedAt, &r.UpdatedAt, &r.DeletedAt, &r.ChangeSeq}, originTargets(&r.Origin)...)
	if err := row.Scan(targets...); err != nil {
		return nil, err
	}
	r.Values.Date = model.DateOf(date)
	r.Values.Status = model.ReportStatus(status)
	return &r, nil
}

// DailyStore implementiert den versionierten Zugriff auf Tagesberichte.
type DailyStore struct{}

func (DailyStore) FindByID(ctx context.Context, tx pgx.Tx, id uuid.UUID, forUpdate bool) (*model.DailyReport, error) {
	sql := `SELECT ` + dailyColumns + ` FROM daily_reports WHERE id = $1`
	if forUpdate {
		sql += ` FOR UPDATE`
	}
	return nilIfNoRows(scanDaily(tx.QueryRow(ctx, sql, id)))
}

func (DailyStore) Insert(ctx context.Context, tx pgx.Tx, userID, id uuid.UUID, v model.DailyValues, m model.WriteMeta) (*model.DailyReport, error) {
	return scanDaily(tx.QueryRow(ctx, `
		INSERT INTO daily_reports (id, user_id, report_date, text, note, order_index, status,
			created_by_device_ref, last_device_ref, last_operation_id, client_updated_at, client_local_id)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $9, $10, $11)
		RETURNING `+dailyColumns,
		id, userID, v.Date.Time(), v.Text, v.Note, v.OrderIndex, string(v.Status),
		m.DeviceRef, m.OperationID, m.ClientUpdatedAt, m.ClientLocalID))
}

func (DailyStore) Update(ctx context.Context, tx pgx.Tx, id uuid.UUID, expected int, v model.DailyValues, m model.WriteMeta) (*model.DailyReport, error) {
	return nilIfNoRows(scanDaily(tx.QueryRow(ctx, `
		UPDATE daily_reports SET report_date = $1, text = $2, note = $3, order_index = $4, status = $5,
			version = version + 1, last_device_ref = $6, last_operation_id = $7, client_updated_at = $8,
			client_local_id = COALESCE($9, client_local_id)
		WHERE id = $10 AND version = $11 AND deleted_at IS NULL
		RETURNING `+dailyColumns,
		v.Date.Time(), v.Text, v.Note, v.OrderIndex, string(v.Status),
		m.DeviceRef, m.OperationID, m.ClientUpdatedAt, m.ClientLocalID, id, expected)))
}

// SoftDelete legt einen Tombstone an: Inhalt wird entfernt (Datenminimierung), ID, Datum und
// Version bleiben für die Synchronisierung erhalten (Aufbewahrung: TOMBSTONE_RETENTION_DAYS).
func (DailyStore) SoftDelete(ctx context.Context, tx pgx.Tx, id uuid.UUID, expected int, m model.WriteMeta) (*model.DailyReport, error) {
	return nilIfNoRows(scanDaily(tx.QueryRow(ctx, `
		UPDATE daily_reports SET deleted_at = now(), text = '', note = '', version = version + 1,
			last_device_ref = $1, last_operation_id = $2, client_updated_at = $3
		WHERE id = $4 AND version = $5 AND deleted_at IS NULL
		RETURNING `+dailyColumns, m.DeviceRef, m.OperationID, m.ClientUpdatedAt, id, expected)))
}

func (DailyStore) FindCollision(context.Context, pgx.Tx, uuid.UUID, uuid.UUID, model.DailyValues) (*model.DailyReport, error) {
	return nil, nil // mehrere Tätigkeiten pro Tag sind erlaubt (wie in der App)
}

func (DailyStore) Owner(r *model.DailyReport) uuid.UUID                { return r.UserID }
func (DailyStore) Version(r *model.DailyReport) int                    { return r.Version }
func (DailyStore) Deleted(r *model.DailyReport) bool                   { return r.DeletedAt != nil }
func (DailyStore) Same(r *model.DailyReport, v model.DailyValues) bool { return r.Values == v }

func FindActiveDaily(ctx context.Context, q Querier, userID, id uuid.UUID) (*model.DailyReport, error) {
	return nilIfNoRows(scanDaily(q.QueryRow(ctx, `SELECT `+dailyColumns+` FROM daily_reports
		WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`, id, userID)))
}

// ReportFilter filtert Listen. Alle Werte werden als Parameter gebunden.
type ReportFilter struct {
	Date      *model.Date
	From, To  *model.Date
	Statuses  []string
	Ascending bool
	Limit     int
	Offset    int
}

func ListDaily(ctx context.Context, q Querier, userID uuid.UUID, f ReportFilter) ([]model.DailyReport, int64, error) {
	b := newWhere("user_id = $1 AND deleted_at IS NULL", userID)
	if f.Date != nil {
		b.add("report_date = $?", f.Date.Time())
	}
	if f.From != nil {
		b.add("report_date >= $?", f.From.Time())
	}
	if f.To != nil {
		b.add("report_date <= $?", f.To.Time())
	}
	if len(f.Statuses) > 0 {
		b.add("status = ANY($?)", f.Statuses)
	}
	var total int64
	if err := q.QueryRow(ctx, `SELECT count(*) FROM daily_reports WHERE `+b.sql(), b.args...).Scan(&total); err != nil {
		return nil, 0, err
	}
	order := "DESC"
	if f.Ascending {
		order = "ASC"
	}
	sql := fmt.Sprintf(`SELECT %s FROM daily_reports WHERE %s
		ORDER BY report_date %s, order_index ASC, created_at ASC, id ASC LIMIT $%d OFFSET $%d`,
		dailyColumns, b.sql(), order, len(b.args)+1, len(b.args)+2)
	items, err := queryAll(ctx, q, scanDaily, sql, append(b.args, f.Limit, f.Offset)...)
	return items, total, err
}

func ListDailyInRange(ctx context.Context, q Querier, userID uuid.UUID, from, to model.Date) ([]model.DailyReport, error) {
	return queryAll(ctx, q, scanDaily, `SELECT `+dailyColumns+` FROM daily_reports
		WHERE user_id = $1 AND deleted_at IS NULL AND report_date BETWEEN $2 AND $3
		ORDER BY report_date ASC, order_index ASC, created_at ASC, id ASC`, userID, from.Time(), to.Time())
}

// DailyChangedSince liefert alle Änderungen inklusive Tombstones nach dem Cursor.
func DailyChangedSince(ctx context.Context, q Querier, userID uuid.UUID, cursor int64, limit int) ([]model.DailyReport, error) {
	return queryAll(ctx, q, scanDaily, `SELECT `+dailyColumns+` FROM daily_reports
		WHERE user_id = $1 AND change_seq > $2 ORDER BY change_seq LIMIT $3`, userID, cursor, limit)
}

// ---------------------------------------------------------------------------
// Wochenberichte
// ---------------------------------------------------------------------------

const weeklyColumns = `id, user_id, week_start, content, status, generated_at, version,
	created_at, updated_at, deleted_at, change_seq, ` + originColumns

func scanWeekly(row interface{ Scan(...any) error }) (*model.WeeklyReport, error) {
	var r model.WeeklyReport
	var start time.Time
	var status string
	targets := append([]any{&r.ID, &r.UserID, &start, &r.Values.Content, &status, &r.Values.GeneratedAt, &r.Version,
		&r.CreatedAt, &r.UpdatedAt, &r.DeletedAt, &r.ChangeSeq}, originTargets(&r.Origin)...)
	if err := row.Scan(targets...); err != nil {
		return nil, err
	}
	r.Values.Week = model.IsoWeek{Start: model.DateOf(start)}
	r.Values.Status = model.ReportStatus(status)
	return &r, nil
}

// WeeklyStore implementiert den versionierten Zugriff auf Wochenberichte.
type WeeklyStore struct{}

func (WeeklyStore) FindByID(ctx context.Context, tx pgx.Tx, id uuid.UUID, forUpdate bool) (*model.WeeklyReport, error) {
	sql := `SELECT ` + weeklyColumns + ` FROM weekly_reports WHERE id = $1`
	if forUpdate {
		sql += ` FOR UPDATE`
	}
	return nilIfNoRows(scanWeekly(tx.QueryRow(ctx, sql, id)))
}

func (WeeklyStore) Insert(ctx context.Context, tx pgx.Tx, userID, id uuid.UUID, v model.WeeklyValues, m model.WriteMeta) (*model.WeeklyReport, error) {
	year, week := v.Week.ISO()
	return scanWeekly(tx.QueryRow(ctx, `
		INSERT INTO weekly_reports (id, user_id, week_start, week_end, iso_year, iso_week, content, status,
			generated_at, created_by_device_ref, last_device_ref, last_operation_id, client_updated_at, client_local_id)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10, $11, $12, $13)
		RETURNING `+weeklyColumns,
		id, userID, v.Week.Start.Time(), v.Week.End().Time(), year, week, v.Content, string(v.Status),
		v.GeneratedAt, m.DeviceRef, m.OperationID, m.ClientUpdatedAt, m.ClientLocalID))
}

func (WeeklyStore) Update(ctx context.Context, tx pgx.Tx, id uuid.UUID, expected int, v model.WeeklyValues, m model.WriteMeta) (*model.WeeklyReport, error) {
	year, week := v.Week.ISO()
	return nilIfNoRows(scanWeekly(tx.QueryRow(ctx, `
		UPDATE weekly_reports SET week_start = $1, week_end = $2, iso_year = $3, iso_week = $4, content = $5,
			status = $6, generated_at = $7, version = version + 1, last_device_ref = $8, last_operation_id = $9,
			client_updated_at = $10, client_local_id = COALESCE($11, client_local_id)
		WHERE id = $12 AND version = $13 AND deleted_at IS NULL
		RETURNING `+weeklyColumns,
		v.Week.Start.Time(), v.Week.End().Time(), year, week, v.Content, string(v.Status), v.GeneratedAt,
		m.DeviceRef, m.OperationID, m.ClientUpdatedAt, m.ClientLocalID, id, expected)))
}

func (WeeklyStore) SoftDelete(ctx context.Context, tx pgx.Tx, id uuid.UUID, expected int, m model.WriteMeta) (*model.WeeklyReport, error) {
	return nilIfNoRows(scanWeekly(tx.QueryRow(ctx, `
		UPDATE weekly_reports SET deleted_at = now(), content = '', version = version + 1,
			last_device_ref = $1, last_operation_id = $2, client_updated_at = $3
		WHERE id = $4 AND version = $5 AND deleted_at IS NULL
		RETURNING `+weeklyColumns, m.DeviceRef, m.OperationID, m.ClientUpdatedAt, id, expected)))
}

// FindCollision liefert einen anderen aktiven Wochenbericht derselben Woche.
func (WeeklyStore) FindCollision(ctx context.Context, tx pgx.Tx, userID, excludeID uuid.UUID, v model.WeeklyValues) (*model.WeeklyReport, error) {
	return nilIfNoRows(scanWeekly(tx.QueryRow(ctx, `SELECT `+weeklyColumns+` FROM weekly_reports
		WHERE user_id = $1 AND week_start = $2 AND deleted_at IS NULL AND id <> $3`,
		userID, v.Week.Start.Time(), excludeID)))
}

func (WeeklyStore) Owner(r *model.WeeklyReport) uuid.UUID                 { return r.UserID }
func (WeeklyStore) Version(r *model.WeeklyReport) int                     { return r.Version }
func (WeeklyStore) Deleted(r *model.WeeklyReport) bool                    { return r.DeletedAt != nil }
func (WeeklyStore) Same(r *model.WeeklyReport, v model.WeeklyValues) bool { return r.Values.Equal(v) }

func FindActiveWeekly(ctx context.Context, q Querier, userID, id uuid.UUID) (*model.WeeklyReport, error) {
	return nilIfNoRows(scanWeekly(q.QueryRow(ctx, `SELECT `+weeklyColumns+` FROM weekly_reports
		WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`, id, userID)))
}

func FindActiveWeeklyForWeek(ctx context.Context, q Querier, userID uuid.UUID, weekStart model.Date) (*model.WeeklyReport, error) {
	return nilIfNoRows(scanWeekly(q.QueryRow(ctx, `SELECT `+weeklyColumns+` FROM weekly_reports
		WHERE user_id = $1 AND week_start = $2 AND deleted_at IS NULL`, userID, weekStart.Time())))
}

// ListWeekly filtert Wochen, die den Zeitraum [From, To] überschneiden.
func ListWeekly(ctx context.Context, q Querier, userID uuid.UUID, f ReportFilter) ([]model.WeeklyReport, int64, error) {
	b := newWhere("user_id = $1 AND deleted_at IS NULL", userID)
	if f.From != nil {
		b.add("week_end >= $?", f.From.Time())
	}
	if f.To != nil {
		b.add("week_start <= $?", f.To.Time())
	}
	if len(f.Statuses) > 0 {
		b.add("status = ANY($?)", f.Statuses)
	}
	var total int64
	if err := q.QueryRow(ctx, `SELECT count(*) FROM weekly_reports WHERE `+b.sql(), b.args...).Scan(&total); err != nil {
		return nil, 0, err
	}
	order := "DESC"
	if f.Ascending {
		order = "ASC"
	}
	sql := fmt.Sprintf(`SELECT %s FROM weekly_reports WHERE %s ORDER BY week_start %s, id ASC LIMIT $%d OFFSET $%d`,
		weeklyColumns, b.sql(), order, len(b.args)+1, len(b.args)+2)
	items, err := queryAll(ctx, q, scanWeekly, sql, append(b.args, f.Limit, f.Offset)...)
	return items, total, err
}

func WeeklyChangedSince(ctx context.Context, q Querier, userID uuid.UUID, cursor int64, limit int) ([]model.WeeklyReport, error) {
	return queryAll(ctx, q, scanWeekly, `SELECT `+weeklyColumns+` FROM weekly_reports
		WHERE user_id = $1 AND change_seq > $2 ORDER BY change_seq LIMIT $3`, userID, cursor, limit)
}

// ServerCursor liefert die höchste Änderungsnummer aller Daten eines Kontos.
func ServerCursor(ctx context.Context, q Querier, userID uuid.UUID) (int64, error) {
	var c int64
	err := q.QueryRow(ctx, `SELECT GREATEST(
		(SELECT COALESCE(MAX(change_seq), 0) FROM daily_reports WHERE user_id = $1),
		(SELECT COALESCE(MAX(change_seq), 0) FROM weekly_reports WHERE user_id = $1),
		(SELECT COALESCE(MAX(change_seq), 0) FROM user_profiles WHERE user_id = $1))`, userID).Scan(&c)
	return c, err
}

// ---------------------------------------------------------------------------
// Hilfsfunktionen
// ---------------------------------------------------------------------------

// where baut WHERE-Klauseln ausschließlich aus festen Fragmenten und Platzhaltern.
type where struct {
	parts []string
	args  []any
}

func newWhere(first string, args ...any) *where { return &where{parts: []string{first}, args: args} }

// add ersetzt "$?" durch den nächsten Platzhalter.
func (w *where) add(fragment string, arg any) {
	w.args = append(w.args, arg)
	w.parts = append(w.parts, strings.Replace(fragment, "$?", fmt.Sprintf("$%d", len(w.args)), 1))
}

func (w *where) sql() string { return strings.Join(w.parts, " AND ") }

// queryAll führt eine Abfrage aus und scannt alle Zeilen.
func queryAll[T any](ctx context.Context, q Querier, scan func(interface{ Scan(...any) error }) (*T, error), sql string, args ...any) ([]T, error) {
	rows, err := q.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []T{}
	for rows.Next() {
		v, err := scan(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, *v)
	}
	return result, rows.Err()
}

func datePtr(t *time.Time) *model.Date {
	if t == nil {
		return nil
	}
	d := model.DateOf(*t)
	return &d
}

func dateParam(d *model.Date) *time.Time {
	if d == nil {
		return nil
	}
	t := d.Time()
	return &t
}

func nilIfNoRows[T any](v *T, err error) (*T, error) {
	if IsNoRows(err) {
		return nil, nil
	}
	return v, err
}
