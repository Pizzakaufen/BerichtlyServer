package model

// JSON-Darstellungen für die API. Feldnamen sind camelCase; Zeitpunkte UTC mit Millisekunden.

type AccountDTO struct {
	ID        string `json:"id"`
	Email     string `json:"email"`
	Timezone  string `json:"timezone"`
	CreatedAt string `json:"createdAt"`
}

func (u *User) DTO() AccountDTO {
	return AccountDTO{u.ID.String(), u.Email, u.Timezone, FormatTime(u.CreatedAt)}
}

type ProfileDTO struct {
	ID            string       `json:"id"` // entspricht der Benutzer-ID
	Name          string       `json:"name"`
	Profession    string       `json:"profession"`
	Company       string       `json:"company"`
	Department    string       `json:"department"`
	TrainerName   string       `json:"trainerName"`
	TrainingStart *string      `json:"trainingStart"`
	TrainingEnd   *string      `json:"trainingEnd"`
	WritingStyle  WritingStyle `json:"writingStyle"`
	Version       int          `json:"version"`
	CreatedAt     string       `json:"createdAt"`
	UpdatedAt     string       `json:"updatedAt"`
}

func (p *Profile) DTO() ProfileDTO {
	return ProfileDTO{
		ID:            p.UserID.String(),
		Name:          p.Values.Name,
		Profession:    p.Values.Profession,
		Company:       p.Values.Company,
		Department:    p.Values.Department,
		TrainerName:   p.Values.TrainerName,
		TrainingStart: dateString(p.Values.TrainingStart),
		TrainingEnd:   dateString(p.Values.TrainingEnd),
		WritingStyle:  p.Values.WritingStyle,
		Version:       p.Version,
		CreatedAt:     FormatTime(p.CreatedAt),
		UpdatedAt:     FormatTime(p.UpdatedAt),
	}
}

type DailyReportDTO struct {
	ID         string       `json:"id"`
	Date       string       `json:"date"`
	Text       string       `json:"text"`
	Note       string       `json:"note"`
	OrderIndex int          `json:"orderIndex"`
	Status     ReportStatus `json:"status"`
	Version    int          `json:"version"`
	CreatedAt  string       `json:"createdAt"`
	UpdatedAt  string       `json:"updatedAt"`
	Deleted    bool         `json:"deleted"`
	DeletedAt  *string      `json:"deletedAt"`
}

func (r *DailyReport) DTO() DailyReportDTO {
	return DailyReportDTO{
		ID:         r.ID.String(),
		Date:       r.Values.Date.String(),
		Text:       r.Values.Text,
		Note:       r.Values.Note,
		OrderIndex: r.Values.OrderIndex,
		Status:     r.Values.Status,
		Version:    r.Version,
		CreatedAt:  FormatTime(r.CreatedAt),
		UpdatedAt:  FormatTime(r.UpdatedAt),
		Deleted:    r.DeletedAt != nil,
		DeletedAt:  FormatTimePtr(r.DeletedAt),
	}
}

type WeeklyReportDTO struct {
	ID          string       `json:"id"`
	WeekStart   string       `json:"weekStart"`
	WeekEnd     string       `json:"weekEnd"`
	IsoYear     int          `json:"isoYear"`
	IsoWeek     int          `json:"isoWeek"`
	Content     string       `json:"content"`
	Status      ReportStatus `json:"status"`
	GeneratedAt *string      `json:"generatedAt"`
	Version     int          `json:"version"`
	CreatedAt   string       `json:"createdAt"`
	UpdatedAt   string       `json:"updatedAt"`
	Deleted     bool         `json:"deleted"`
	DeletedAt   *string      `json:"deletedAt"`
}

func (r *WeeklyReport) DTO() WeeklyReportDTO {
	year, week := r.Values.Week.ISO()
	return WeeklyReportDTO{
		ID:          r.ID.String(),
		WeekStart:   r.Values.Week.Start.String(),
		WeekEnd:     r.Values.Week.End().String(),
		IsoYear:     year,
		IsoWeek:     week,
		Content:     r.Values.Content,
		Status:      r.Values.Status,
		GeneratedAt: FormatTimePtr(r.Values.GeneratedAt),
		Version:     r.Version,
		CreatedAt:   FormatTime(r.CreatedAt),
		UpdatedAt:   FormatTime(r.UpdatedAt),
		Deleted:     r.DeletedAt != nil,
		DeletedAt:   FormatTimePtr(r.DeletedAt),
	}
}

type DeviceDTO struct {
	ID             string  `json:"id"` // stabile Geräte-ID des Clients
	Name           string  `json:"name"`
	Platform       string  `json:"platform"`
	AppVersion     string  `json:"appVersion"`
	CreatedAt      string  `json:"createdAt"`
	LastSeenAt     string  `json:"lastSeenAt"`
	LastPullAt     *string `json:"lastPullAt"`
	LastPushAt     *string `json:"lastPushAt"`
	ActiveSessions int     `json:"activeSessions"`
	Current        bool    `json:"current"`
}

func (d *Device) DTO(current bool) DeviceDTO {
	return DeviceDTO{
		ID:             d.DeviceID.String(),
		Name:           d.Name,
		Platform:       d.Platform,
		AppVersion:     d.AppVersion,
		CreatedAt:      FormatTime(d.CreatedAt),
		LastSeenAt:     FormatTime(d.LastSeenAt),
		LastPullAt:     FormatTimePtr(d.LastPullAt),
		LastPushAt:     FormatTimePtr(d.LastPushAt),
		ActiveSessions: d.ActiveSessions,
		Current:        current,
	}
}

func dateString(d *Date) *string {
	if d == nil {
		return nil
	}
	s := d.String()
	return &s
}
