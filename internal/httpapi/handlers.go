package httpapi

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/google/uuid"

	"berichtly-server/internal/apperr"
	"berichtly-server/internal/model"
	"berichtly-server/internal/service"
	"berichtly-server/internal/store"
	"berichtly-server/internal/validate"
)

// ---------------------------------------------------------------------------
// Authentifizierung
// ---------------------------------------------------------------------------

func (a *API) register(w http.ResponseWriter, r *http.Request) {
	var req service.RegisterRequest
	if err := decodeJSON(w, r, a.cfg.Server.MaxBodyBytes, &req); err != nil {
		writeError(w, r, err)
		return
	}
	resp, err := a.auth.Register(r.Context(), req)
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeData(w, http.StatusCreated, resp)
}

func (a *API) login(w http.ResponseWriter, r *http.Request) {
	var req service.LoginRequest
	if err := decodeJSON(w, r, a.cfg.Server.MaxBodyBytes, &req); err != nil {
		writeError(w, r, err)
		return
	}
	resp, err := a.auth.Login(r.Context(), req)
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeData(w, http.StatusOK, resp)
}

func (a *API) refresh(w http.ResponseWriter, r *http.Request) {
	var req service.RefreshRequest
	if err := decodeJSON(w, r, a.cfg.Server.MaxBodyBytes, &req); err != nil {
		writeError(w, r, err)
		return
	}
	resp, err := a.auth.Refresh(r.Context(), req)
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeData(w, http.StatusOK, resp)
}

func (a *API) logout(w http.ResponseWriter, r *http.Request) {
	if err := a.auth.Logout(r.Context(), principal(r)); err != nil {
		writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ---------------------------------------------------------------------------
// Konto und Profil
// ---------------------------------------------------------------------------

func (a *API) getAccount(w http.ResponseWriter, r *http.Request) {
	u, err := a.account.Get(r.Context(), principal(r).UserID)
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeData(w, http.StatusOK, u.DTO())
}

func (a *API) updateAccount(w http.ResponseWriter, r *http.Request) {
	var req service.AccountUpdateRequest
	if err := decodeJSON(w, r, a.cfg.Server.MaxBodyBytes, &req); err != nil {
		writeError(w, r, err)
		return
	}
	u, err := a.account.Update(r.Context(), principal(r).UserID, req)
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeData(w, http.StatusOK, u.DTO())
}

func (a *API) getProfile(w http.ResponseWriter, r *http.Request) {
	p, err := a.profiles.Get(r.Context(), principal(r).UserID)
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeData(w, http.StatusOK, p.DTO())
}

func (a *API) updateProfile(w http.ResponseWriter, r *http.Request) {
	var req service.ProfileRequest
	if err := decodeJSON(w, r, a.cfg.Server.MaxBodyBytes, &req); err != nil {
		writeError(w, r, err)
		return
	}
	v := validate.New()
	version, _ := v.Int("version", req.Version, 1, 1<<31-1, 0, true)
	values := req.Values(v)
	if err := v.Err(); err != nil {
		writeError(w, r, err)
		return
	}
	out, err := a.profiles.Update(r.Context(), principal(r).UserID, version, values)
	if err == nil {
		var p *model.Profile
		if p, err = service.RequireApplied(out, "Profil", profileVersion, profileDTO); err == nil {
			writeData(w, http.StatusOK, p.DTO())
			return
		}
	}
	writeError(w, r, err)
}

// ---------------------------------------------------------------------------
// Tagesberichte
// ---------------------------------------------------------------------------

func (a *API) listDaily(w http.ResponseWriter, r *http.Request) {
	f, p, err := reportFilter(r, true)
	if err != nil {
		writeError(w, r, err)
		return
	}
	items, total, err := a.reports.ListDaily(r.Context(), principal(r).UserID, f)
	if err != nil {
		writeError(w, r, err)
		return
	}
	dtos := make([]model.DailyReportDTO, len(items))
	for i := range items {
		dtos[i] = items[i].DTO()
	}
	writePage(w, dtos, p, total)
}

func (a *API) getDaily(w http.ResponseWriter, r *http.Request) {
	id, err := pathUUID(r, "id")
	if err != nil {
		writeError(w, r, err)
		return
	}
	rep, err := a.reports.GetDaily(r.Context(), principal(r).UserID, id)
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeData(w, http.StatusOK, rep.DTO())
}

func (a *API) createDaily(w http.ResponseWriter, r *http.Request) {
	var req service.DailyReportRequest
	if err := decodeJSON(w, r, a.cfg.Server.MaxBodyBytes, &req); err != nil {
		writeError(w, r, err)
		return
	}
	v := validate.New()
	id := uuid.New()
	if req.ID != nil {
		id, _ = v.UUID("id", req.ID, true)
	}
	values := req.Values(v)
	if err := v.Err(); err != nil {
		writeError(w, r, err)
		return
	}
	p := principal(r)
	out, err := a.reports.Daily.Create(r.Context(), p.UserID, id, values, p.DeviceRef)
	writeOutcome(w, r, out, err, "Tagesbericht", dailyVersion, dailyDTO, true)
}

func (a *API) updateDaily(w http.ResponseWriter, r *http.Request) {
	id, base, values, err := decodeUpdate(a, w, r, func(req service.DailyReportRequest, v *validate.V) (*string, *int, model.DailyValues) {
		return req.ID, req.Version, req.Values(v)
	})
	if err != nil {
		writeError(w, r, err)
		return
	}
	p := principal(r)
	out, err := a.reports.Daily.Update(r.Context(), p.UserID, id, base, values, p.DeviceRef)
	writeOutcome(w, r, out, err, "Tagesbericht", dailyVersion, dailyDTO, false)
}

func (a *API) deleteDaily(w http.ResponseWriter, r *http.Request) {
	id, base, err := deleteParams(r)
	if err != nil {
		writeError(w, r, err)
		return
	}
	p := principal(r)
	out, err := a.reports.Daily.Delete(r.Context(), p.UserID, id, base, p.DeviceRef)
	if err == nil {
		_, err = service.RequireApplied(out, "Tagesbericht", dailyVersion, dailyDTO)
	}
	if err != nil {
		writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ---------------------------------------------------------------------------
// Wochenberichte und Wochen
// ---------------------------------------------------------------------------

func (a *API) listWeekly(w http.ResponseWriter, r *http.Request) {
	f, p, err := reportFilter(r, false)
	if err != nil {
		writeError(w, r, err)
		return
	}
	items, total, err := a.reports.ListWeekly(r.Context(), principal(r).UserID, f)
	if err != nil {
		writeError(w, r, err)
		return
	}
	dtos := make([]model.WeeklyReportDTO, len(items))
	for i := range items {
		dtos[i] = items[i].DTO()
	}
	writePage(w, dtos, p, total)
}

func (a *API) getWeekly(w http.ResponseWriter, r *http.Request) {
	id, err := pathUUID(r, "id")
	if err != nil {
		writeError(w, r, err)
		return
	}
	rep, err := a.reports.GetWeekly(r.Context(), principal(r).UserID, id)
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeData(w, http.StatusOK, rep.DTO())
}

func (a *API) createWeekly(w http.ResponseWriter, r *http.Request) {
	var req service.WeeklyReportRequest
	if err := decodeJSON(w, r, a.cfg.Server.MaxBodyBytes, &req); err != nil {
		writeError(w, r, err)
		return
	}
	v := validate.New()
	id := uuid.New()
	if req.ID != nil {
		id, _ = v.UUID("id", req.ID, true)
	}
	values := req.Values(v)
	if err := v.Err(); err != nil {
		writeError(w, r, err)
		return
	}
	p := principal(r)
	out, err := a.reports.Weekly.Create(r.Context(), p.UserID, id, values, p.DeviceRef)
	writeOutcome(w, r, out, err, "Wochenbericht", weeklyVersion, weeklyDTO, true)
}

func (a *API) updateWeekly(w http.ResponseWriter, r *http.Request) {
	id, base, values, err := decodeUpdate(a, w, r, func(req service.WeeklyReportRequest, v *validate.V) (*string, *int, model.WeeklyValues) {
		return req.ID, req.Version, req.Values(v)
	})
	if err != nil {
		writeError(w, r, err)
		return
	}
	p := principal(r)
	out, err := a.reports.Weekly.Update(r.Context(), p.UserID, id, base, values, p.DeviceRef)
	writeOutcome(w, r, out, err, "Wochenbericht", weeklyVersion, weeklyDTO, false)
}

func (a *API) deleteWeekly(w http.ResponseWriter, r *http.Request) {
	id, base, err := deleteParams(r)
	if err != nil {
		writeError(w, r, err)
		return
	}
	p := principal(r)
	out, err := a.reports.Weekly.Delete(r.Context(), p.UserID, id, base, p.DeviceRef)
	if err == nil {
		_, err = service.RequireApplied(out, "Wochenbericht", weeklyVersion, weeklyDTO)
	}
	if err != nil {
		writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type weekDayDTO struct {
	Date         string                 `json:"date"`
	DayOfWeek    string                 `json:"dayOfWeek"`
	DailyReports []model.DailyReportDTO `json:"dailyReports"`
}

type weekDTO struct {
	WeekStart    string                 `json:"weekStart"`
	WeekEnd      string                 `json:"weekEnd"`
	IsoYear      int                    `json:"isoYear"`
	IsoWeek      int                    `json:"isoWeek"`
	Timezone     string                 `json:"timezone"`
	Days         []weekDayDTO           `json:"days"`
	WeeklyReport *model.WeeklyReportDTO `json:"weeklyReport"`
}

func (a *API) currentWeek(w http.ResponseWriter, r *http.Request) { a.writeWeek(w, r, nil) }

func (a *API) week(w http.ResponseWriter, r *http.Request) {
	d, ok := model.ParseDate(r.PathValue("date"))
	if !ok || !d.InRange() {
		writeError(w, r, apperr.BadParameter("date", "invalid_date"))
		return
	}
	a.writeWeek(w, r, &d)
}

func (a *API) writeWeek(w http.ResponseWriter, r *http.Request, date *model.Date) {
	ov, err := a.reports.Week(r.Context(), principal(r).UserID, date)
	if err != nil {
		writeError(w, r, err)
		return
	}
	year, week := ov.Week.ISO()
	out := weekDTO{WeekStart: ov.Week.Start.String(), WeekEnd: ov.Week.End().String(), IsoYear: year,
		IsoWeek: week, Timezone: ov.Timezone}
	for _, day := range ov.Week.Days() {
		wd := weekDayDTO{Date: day.String(), DayOfWeek: strings.ToUpper(day.Weekday().String()),
			DailyReports: []model.DailyReportDTO{}}
		for i := range ov.Daily {
			if ov.Daily[i].Values.Date == day {
				wd.DailyReports = append(wd.DailyReports, ov.Daily[i].DTO())
			}
		}
		out.Days = append(out.Days, wd)
	}
	if ov.Weekly != nil {
		dto := ov.Weekly.DTO()
		out.WeeklyReport = &dto
	}
	writeData(w, http.StatusOK, out)
}

// ---------------------------------------------------------------------------
// Synchronisierung und Geräte
// ---------------------------------------------------------------------------

func (a *API) syncPull(w http.ResponseWriter, r *http.Request) {
	cursor := int64(0)
	if raw := r.URL.Query().Get("cursor"); raw != "" {
		c, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || c < 0 {
			writeError(w, r, apperr.BadParameter("cursor", "invalid_cursor"))
			return
		}
		cursor = c
	}
	limit, err := queryInt(r, "limit", service.DefaultPullLimit, 1, service.MaxPullLimit)
	if err != nil {
		writeError(w, r, err)
		return
	}
	resp, err := a.sync.Pull(r.Context(), principal(r), cursor, limit)
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeData(w, http.StatusOK, resp)
}

func (a *API) syncPush(w http.ResponseWriter, r *http.Request) {
	var req service.SyncPushRequest
	if err := decodeJSON(w, r, a.cfg.Server.MaxBodyBytes, &req); err != nil {
		writeError(w, r, err)
		return
	}
	resp, err := a.sync.Push(r.Context(), principal(r), req)
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeData(w, http.StatusOK, resp)
}

func (a *API) syncStatus(w http.ResponseWriter, r *http.Request) {
	resp, err := a.sync.Status(r.Context(), principal(r))
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeData(w, http.StatusOK, resp)
}

func (a *API) listDevices(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	devices, err := a.devices.List(r.Context(), p.UserID)
	if err != nil {
		writeError(w, r, err)
		return
	}
	dtos := make([]model.DeviceDTO, len(devices))
	for i := range devices {
		dtos[i] = devices[i].DTO(p.DeviceRef != nil && *p.DeviceRef == devices[i].Ref)
	}
	writeData(w, http.StatusOK, dtos)
}

func (a *API) signOutDevice(w http.ResponseWriter, r *http.Request) {
	id, err := pathUUID(r, "id")
	if err == nil {
		err = a.devices.SignOut(r.Context(), principal(r).UserID, id)
	}
	if err != nil {
		writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ---------------------------------------------------------------------------
// Hilfsfunktionen
// ---------------------------------------------------------------------------

func dailyVersion(r *model.DailyReport) int   { return r.Version }
func dailyDTO(r *model.DailyReport) any       { return r.DTO() }
func weeklyVersion(r *model.WeeklyReport) int { return r.Version }
func weeklyDTO(r *model.WeeklyReport) any     { return r.DTO() }
func profileVersion(r *model.Profile) int     { return r.Version }
func profileDTO(r *model.Profile) any         { return r.DTO() }

// writeOutcome antwortet mit 201 (neu), 200 (geändert/idempotent), 409 (Konflikt) oder 404.
func writeOutcome[R any](w http.ResponseWriter, r *http.Request, out service.Outcome[R], err error, what string,
	version func(*R) int, dto func(*R) any, create bool) {
	if err == nil {
		var rec *R
		if rec, err = service.RequireApplied(out, what, version, dto); err == nil {
			status := http.StatusOK
			if create && out.Created {
				status = http.StatusCreated
			}
			writeData(w, status, dto(rec))
			return
		}
	}
	writeError(w, r, err)
}

// decodeUpdate liest Pfad-ID, Body und Basisversion für PUT-Anfragen.
func decodeUpdate[Req any, V any](a *API, w http.ResponseWriter, r *http.Request,
	extract func(Req, *validate.V) (*string, *int, V)) (uuid.UUID, int, V, error) {
	var zero V
	id, err := pathUUID(r, "id")
	if err != nil {
		return uuid.Nil, 0, zero, err
	}
	var req Req
	if err := decodeJSON(w, r, a.cfg.Server.MaxBodyBytes, &req); err != nil {
		return uuid.Nil, 0, zero, err
	}
	v := validate.New()
	bodyID, version, values := extract(req, v)
	base, _ := v.Int("version", version, 1, 1<<31-1, 0, true)
	if bodyID != nil && *bodyID != id.String() {
		v.Add("id", "must_match_path")
	}
	return id, base, values, v.Err()
}

func deleteParams(r *http.Request) (uuid.UUID, int, error) {
	id, err := pathUUID(r, "id")
	if err != nil {
		return uuid.Nil, 0, err
	}
	if r.URL.Query().Get("version") == "" {
		return uuid.Nil, 0, apperr.BadParameter("version", "required")
	}
	base, err := queryInt(r, "version", 0, 1, 1<<31-1)
	return id, base, err
}

func reportFilter(r *http.Request, daily bool) (store.ReportFilter, page, error) {
	var f store.ReportFilter
	p, err := pageParams(r)
	if err != nil {
		return f, p, err
	}
	f.Limit, f.Offset = p.limit, p.offset()
	q := r.URL.Query()
	parseDate := func(name string) (*model.Date, error) {
		raw := q.Get(name)
		if raw == "" {
			return nil, nil
		}
		d, ok := model.ParseDate(raw)
		if !ok || !d.InRange() {
			return nil, apperr.BadParameter(name, "invalid_date")
		}
		return &d, nil
	}
	if daily {
		if f.Date, err = parseDate("date"); err != nil {
			return f, p, err
		}
	}
	if f.From, err = parseDate("from"); err != nil {
		return f, p, err
	}
	if f.To, err = parseDate("to"); err != nil {
		return f, p, err
	}
	if f.From != nil && f.To != nil && f.To.Before(*f.From) {
		return f, p, apperr.BadParameter("to", "before_from")
	}
	if raw := q.Get("status"); raw != "" {
		for _, s := range strings.Split(raw, ",") {
			s = strings.TrimSpace(s)
			valid := false
			for _, allowed := range model.ReportStatuses {
				valid = valid || s == allowed
			}
			if !valid {
				return f, p, apperr.BadParameter("status", "invalid_value:"+strings.Join(model.ReportStatuses, "|"))
			}
			f.Statuses = append(f.Statuses, s)
		}
	}
	switch q.Get("sort") {
	case "", "date_desc":
	case "date_asc":
		f.Ascending = true
	default:
		return f, p, apperr.BadParameter("sort", "invalid_value:date_asc|date_desc")
	}
	return f, p, nil
}
