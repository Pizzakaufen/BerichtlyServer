package httpapi

import (
	"net/http"
	"strconv"
	"strings"
	"time"

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
	// Zusätzliches Limit pro Konto (E-Mail): schützt auch vor Angriffen über viele IP-Adressen.
	// Der Schlüssel ist ein Hash; die E-Mail-Adresse selbst wird nirgends gespeichert.
	if req.Email != nil {
		key := hashKey(strings.ToLower(strings.TrimSpace(*req.Email)))
		if ok, retry := a.accountLimiter.allow(key); !ok {
			writeRateLimited(w, r, retry)
			return
		}
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

func (a *API) logoutAll(w http.ResponseWriter, r *http.Request) {
	n, err := a.auth.LogoutAll(r.Context(), principal(r))
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeData(w, http.StatusOK, map[string]any{"revokedSessions": n})
}

// ---------------------------------------------------------------------------
// Konto, Sitzungen und Profil
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

func (a *API) changePassword(w http.ResponseWriter, r *http.Request) {
	var req service.PasswordChangeRequest
	if err := decodeJSON(w, r, a.cfg.Server.MaxBodyBytes, &req); err != nil {
		writeError(w, r, err)
		return
	}
	if err := a.auth.ChangePassword(r.Context(), principal(r), req); err != nil {
		writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) securityEvents(w http.ResponseWriter, r *http.Request) {
	p, err := pageParams(r)
	if err != nil {
		writeError(w, r, err)
		return
	}
	items, total, err := a.account.SecurityEvents(r.Context(), principal(r).UserID, p.limit, p.offset())
	if err != nil {
		writeError(w, r, err)
		return
	}
	dtos := make([]model.SecurityEventDTO, len(items))
	for i := range items {
		dtos[i] = items[i].DTO()
	}
	writePage(w, dtos, p, total)
}

func (a *API) listSessions(w http.ResponseWriter, r *http.Request) {
	p, err := pageParams(r)
	if err != nil {
		writeError(w, r, err)
		return
	}
	pr := principal(r)
	items, total, err := a.auth.Sessions(r.Context(), pr.UserID, p.limit, p.offset())
	if err != nil {
		writeError(w, r, err)
		return
	}
	dtos := make([]model.SessionDTO, len(items))
	for i := range items {
		dtos[i] = items[i].DTO(items[i].ID == pr.SessionID)
	}
	writePage(w, dtos, p, total)
}

func (a *API) revokeSession(w http.ResponseWriter, r *http.Request) {
	id, err := pathUUID(r, "id")
	if err == nil {
		err = a.auth.RevokeSession(r.Context(), principal(r), id)
	}
	if err != nil {
		writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
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
	p := principal(r)
	v := validate.New()
	id := uuid.New()
	if req.ID != nil {
		id, _ = v.UUID("id", req.ID, true)
	}
	values := req.Values(v)
	meta := req.ClientInfo.Meta(v, p.DeviceRef, nil)
	if err := v.Err(); err != nil {
		writeError(w, r, err)
		return
	}
	out, err := a.reports.Daily.Create(r.Context(), p.UserID, id, values, meta)
	writeOutcome(w, r, out, err, "Tagesbericht", dailyVersion, dailyDTO, true)
}

func (a *API) updateDaily(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	id, base, values, meta, err := decodeUpdate(a, w, r, p, func(req service.DailyReportRequest, v *validate.V) (*string, *int, model.DailyValues, service.ClientInfo) {
		return req.ID, req.Version, req.Values(v), req.ClientInfo
	})
	if err != nil {
		writeError(w, r, err)
		return
	}
	out, err := a.reports.Daily.Update(r.Context(), p.UserID, id, base, values, meta)
	writeOutcome(w, r, out, err, "Tagesbericht", dailyVersion, dailyDTO, false)
}

func (a *API) deleteDaily(w http.ResponseWriter, r *http.Request) {
	id, base, err := deleteParams(r)
	if err != nil {
		writeError(w, r, err)
		return
	}
	p := principal(r)
	out, err := a.reports.Daily.Delete(r.Context(), p.UserID, id, base, model.WriteMeta{DeviceRef: p.DeviceRef})
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
	p := principal(r)
	v := validate.New()
	id := uuid.New()
	if req.ID != nil {
		id, _ = v.UUID("id", req.ID, true)
	}
	values := req.Values(v)
	meta := req.ClientInfo.Meta(v, p.DeviceRef, nil)
	if err := v.Err(); err != nil {
		writeError(w, r, err)
		return
	}
	out, err := a.reports.Weekly.Create(r.Context(), p.UserID, id, values, meta)
	writeOutcome(w, r, out, err, "Wochenbericht", weeklyVersion, weeklyDTO, true)
}

func (a *API) updateWeekly(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	id, base, values, meta, err := decodeUpdate(a, w, r, p, func(req service.WeeklyReportRequest, v *validate.V) (*string, *int, model.WeeklyValues, service.ClientInfo) {
		return req.ID, req.Version, req.Values(v), req.ClientInfo
	})
	if err != nil {
		writeError(w, r, err)
		return
	}
	out, err := a.reports.Weekly.Update(r.Context(), p.UserID, id, base, values, meta)
	writeOutcome(w, r, out, err, "Wochenbericht", weeklyVersion, weeklyDTO, false)
}

func (a *API) deleteWeekly(w http.ResponseWriter, r *http.Request) {
	id, base, err := deleteParams(r)
	if err != nil {
		writeError(w, r, err)
		return
	}
	p := principal(r)
	out, err := a.reports.Weekly.Delete(r.Context(), p.UserID, id, base, model.WriteMeta{DeviceRef: p.DeviceRef})
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
	WeekStart string `json:"weekStart"`
	WeekEnd   string `json:"weekEnd"`
	IsoYear   int    `json:"isoYear"`
	IsoWeek   int    `json:"isoWeek"`
	Timezone  string `json:"timezone"`
	// "Heute" in der Zeitzone des Benutzers (1.1).
	Today        string                 `json:"today"`
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

func (a *API) weekByISO(w http.ResponseWriter, r *http.Request) {
	year, err1 := strconv.Atoi(r.PathValue("isoYear"))
	week, err2 := strconv.Atoi(r.PathValue("isoWeek"))
	iso, ok := model.IsoWeekOf(year, week)
	if err1 != nil || err2 != nil || !ok {
		writeError(w, r, apperr.BadParameter("isoWeek", "invalid_iso_week"))
		return
	}
	a.writeWeek(w, r, &iso.Start)
}

func (a *API) writeWeek(w http.ResponseWriter, r *http.Request, date *model.Date) {
	ov, err := a.reports.Week(r.Context(), principal(r).UserID, date)
	if err != nil {
		writeError(w, r, err)
		return
	}
	year, week := ov.Week.ISO()
	out := weekDTO{WeekStart: ov.Week.Start.String(), WeekEnd: ov.Week.End().String(), IsoYear: year,
		IsoWeek: week, Timezone: ov.Timezone, Today: ov.Today.String()}
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
// Synchronisierung
// ---------------------------------------------------------------------------

func (a *API) syncPull(w http.ResponseWriter, r *http.Request) {
	raw := r.URL.Query().Get("cursor")
	cursor, err := service.ParseCursor(&raw)
	if err != nil {
		writeError(w, r, err)
		return
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

func (a *API) syncCombined(w http.ResponseWriter, r *http.Request) {
	var req service.SyncRequest
	if err := decodeJSON(w, r, a.cfg.Server.MaxBodyBytes, &req); err != nil {
		writeError(w, r, err)
		return
	}
	resp, err := a.sync.Sync(r.Context(), principal(r), req)
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeData(w, http.StatusOK, resp)
}

func (a *API) syncComplete(w http.ResponseWriter, r *http.Request) {
	var req service.SyncCompleteRequest
	if err := decodeJSON(w, r, a.cfg.Server.MaxBodyBytes, &req); err != nil {
		writeError(w, r, err)
		return
	}
	resp, err := a.sync.Complete(r.Context(), principal(r), req)
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

// ---------------------------------------------------------------------------
// Geräte
// ---------------------------------------------------------------------------

func (a *API) registerDevice(w http.ResponseWriter, r *http.Request) {
	var req service.DeviceRequest
	if err := decodeJSON(w, r, a.cfg.Server.MaxBodyBytes, &req); err != nil {
		writeError(w, r, err)
		return
	}
	d, created, err := a.devices.Register(r.Context(), principal(r), req)
	if err != nil {
		writeError(w, r, err)
		return
	}
	status := http.StatusOK
	if created {
		status = http.StatusCreated
	}
	writeData(w, status, d.DTO(true))
}

func (a *API) listDevices(w http.ResponseWriter, r *http.Request) {
	p, err := pageParams(r)
	if err != nil {
		writeError(w, r, err)
		return
	}
	includeRevoked := false
	switch r.URL.Query().Get("includeRevoked") {
	case "", "false":
	case "true":
		includeRevoked = true
	default:
		writeError(w, r, apperr.BadParameter("includeRevoked", "invalid_value:true|false"))
		return
	}
	pr := principal(r)
	devices, total, err := a.devices.List(r.Context(), pr.UserID, includeRevoked, p.limit, p.offset())
	if err != nil {
		writeError(w, r, err)
		return
	}
	dtos := make([]model.DeviceDTO, len(devices))
	for i := range devices {
		dtos[i] = devices[i].DTO(pr.DeviceRef != nil && *pr.DeviceRef == devices[i].Ref)
	}
	writePage(w, dtos, p, total)
}

func (a *API) getDevice(w http.ResponseWriter, r *http.Request) {
	id, err := pathUUID(r, "id")
	if err != nil {
		writeError(w, r, err)
		return
	}
	pr := principal(r)
	d, err := a.devices.Get(r.Context(), pr.UserID, id)
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeData(w, http.StatusOK, d.DTO(pr.DeviceRef != nil && *pr.DeviceRef == d.Ref))
}

func (a *API) updateDevice(w http.ResponseWriter, r *http.Request) {
	id, err := pathUUID(r, "id")
	if err != nil {
		writeError(w, r, err)
		return
	}
	var req service.DeviceUpdateRequest
	if err := decodeJSON(w, r, a.cfg.Server.MaxBodyBytes, &req); err != nil {
		writeError(w, r, err)
		return
	}
	pr := principal(r)
	d, err := a.devices.Update(r.Context(), pr.UserID, id, req)
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeData(w, http.StatusOK, d.DTO(pr.DeviceRef != nil && *pr.DeviceRef == d.Ref))
}

func (a *API) signOutDevice(w http.ResponseWriter, r *http.Request) {
	id, err := pathUUID(r, "id")
	if err == nil {
		err = a.devices.Revoke(r.Context(), principal(r), id)
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

// decodeUpdate liest Pfad-ID, Body, Basisversion und Clientangaben für PUT-Anfragen.
func decodeUpdate[Req any, V any](a *API, w http.ResponseWriter, r *http.Request, p service.Principal,
	extract func(Req, *validate.V) (*string, *int, V, service.ClientInfo)) (uuid.UUID, int, V, model.WriteMeta, error) {
	var zero V
	id, err := pathUUID(r, "id")
	if err != nil {
		return uuid.Nil, 0, zero, model.WriteMeta{}, err
	}
	var req Req
	if err := decodeJSON(w, r, a.cfg.Server.MaxBodyBytes, &req); err != nil {
		return uuid.Nil, 0, zero, model.WriteMeta{}, err
	}
	v := validate.New()
	bodyID, version, values, client := extract(req, v)
	base, _ := v.Int("version", version, 1, 1<<31-1, 0, true)
	if bodyID != nil && *bodyID != id.String() {
		v.Add("id", "must_match_path")
	}
	meta := client.Meta(v, p.DeviceRef, nil)
	return id, base, values, meta, v.Err()
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

// reportFilter liest Listenfilter. Zeitraumfilter (from/to, year/month, isoYear/isoWeek) werden
// kombiniert (Schnittmenge).
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
	// Monat bzw. Jahr
	if q.Get("year") != "" {
		year, err := queryInt(r, "year", 0, model.MinDate.Year, model.MaxDate.Year)
		if err != nil {
			return f, p, err
		}
		from, to := model.Date{Year: year, Month: time.January, Day: 1}, model.Date{Year: year, Month: time.December, Day: 31}
		if q.Get("month") != "" {
			month, err := queryInt(r, "month", 0, 1, 12)
			if err != nil {
				return f, p, err
			}
			from, to = model.MonthRange(year, time.Month(month))
		}
		f.From, f.To = intersect(f.From, f.To, from, to)
	} else if q.Get("month") != "" {
		return f, p, apperr.BadParameter("month", "requires_year")
	}
	// ISO-Kalenderwoche
	if q.Get("isoYear") != "" || q.Get("isoWeek") != "" {
		year, err1 := strconv.Atoi(q.Get("isoYear"))
		week, err2 := strconv.Atoi(q.Get("isoWeek"))
		iso, ok := model.IsoWeekOf(year, week)
		if err1 != nil || err2 != nil || !ok {
			return f, p, apperr.BadParameter("isoWeek", "invalid_iso_week")
		}
		f.From, f.To = intersect(f.From, f.To, iso.Start, iso.End())
	}
	if f.From != nil && f.To != nil && f.To.Before(*f.From) {
		if q.Get("from") != "" && q.Get("to") != "" && q.Get("year") == "" && q.Get("isoWeek") == "" {
			return f, p, apperr.BadParameter("to", "before_from")
		}
		// Leere Schnittmenge aus mehreren Filtern: ergibt eine leere Liste.
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

// intersect schränkt einen bestehenden Zeitraum auf [from, to] ein.
func intersect(curFrom, curTo *model.Date, from, to model.Date) (*model.Date, *model.Date) {
	if curFrom == nil || curFrom.Before(from) {
		curFrom = &from
	}
	if curTo == nil || to.Before(*curTo) {
		curTo = &to
	}
	return curFrom, curTo
}
