package model

import "github.com/google/uuid"

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
	OriginDTO
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
		OriginDTO:  r.Origin.DTO(),
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
	OriginDTO
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
		OriginDTO:   r.Origin.DTO(),
	}
}

// OriginDTO enthält die Herkunftsangaben eines Berichts (in Berichts-DTOs eingebettet).
// Alle Felder sind schreibgeschützt bzw. reine Clientangaben ohne Einfluss auf Entscheidungen.
type OriginDTO struct {
	// Vom Gerät gemeldeter Änderungszeitpunkt (Clientzeit, nur informativ).
	ClientUpdatedAt *string `json:"clientUpdatedAt"`
	// Lokale ID des Datensatzes auf dem Gerät (z. B. Room-ID).
	ClientLocalID *string `json:"clientLocalId"`
	// Gerät, das den Bericht erstellt bzw. zuletzt geändert hat (stabile Geräte-ID).
	CreatedByDeviceID      *string `json:"createdByDeviceId"`
	LastModifiedByDeviceID *string `json:"lastModifiedByDeviceId"`
	// Synchronisationsoperation der letzten Änderung.
	LastOperationID *string `json:"lastOperationId"`
}

func (o Origin) DTO() OriginDTO {
	return OriginDTO{
		ClientUpdatedAt:        FormatTimePtr(o.ClientUpdatedAt),
		ClientLocalID:          o.ClientLocalID,
		CreatedByDeviceID:      uuidString(o.CreatedByDeviceID),
		LastModifiedByDeviceID: uuidString(o.LastDeviceID),
		LastOperationID:        uuidString(o.LastOperationID),
	}
}

type DeviceDTO struct {
	ID         string `json:"id"` // stabile Geräte-ID des Clients
	Name       string `json:"name"`
	Platform   string `json:"platform"`
	OSVersion  string `json:"osVersion"`
	AppVersion string `json:"appVersion"`
	CreatedAt  string `json:"createdAt"`
	// Letzte Aktivität (auf wenige Minuten genau).
	LastSeenAt string  `json:"lastSeenAt"`
	RevokedAt  *string `json:"revokedAt"`
	// Synchronisationsstatus: NEVER | SUCCESS | FAILED | CONFLICT
	SyncStatus          SyncStatus `json:"syncStatus"`
	LastSyncAt          *string    `json:"lastSyncAt"` // letzte erfolgreiche Synchronisierung
	LastSyncStartedAt   *string    `json:"lastSyncStartedAt"`
	LastFailedSyncAt    *string    `json:"lastFailedSyncAt"`
	LastSyncErrorCode   *string    `json:"lastSyncErrorCode"`
	UnresolvedConflicts int        `json:"unresolvedConflicts"`
	LastPullAt          *string    `json:"lastPullAt"`
	LastPushAt          *string    `json:"lastPushAt"`
	ActiveSessions      int        `json:"activeSessions"`
	Current             bool       `json:"current"`
}

func (d *Device) DTO(current bool) DeviceDTO {
	return DeviceDTO{
		ID:                  d.DeviceID.String(),
		Name:                d.Name,
		Platform:            d.Platform,
		OSVersion:           d.OSVersion,
		AppVersion:          d.AppVersion,
		CreatedAt:           FormatTime(d.CreatedAt),
		LastSeenAt:          FormatTime(d.LastSeenAt),
		RevokedAt:           FormatTimePtr(d.RevokedAt),
		SyncStatus:          d.SyncStatus,
		LastSyncAt:          FormatTimePtr(d.LastSuccessfulSyncAt),
		LastSyncStartedAt:   FormatTimePtr(d.LastSyncStartedAt),
		LastFailedSyncAt:    FormatTimePtr(d.LastFailedSyncAt),
		LastSyncErrorCode:   d.LastSyncErrorCode,
		UnresolvedConflicts: d.UnresolvedConflicts,
		LastPullAt:          FormatTimePtr(d.LastPullAt),
		LastPushAt:          FormatTimePtr(d.LastPushAt),
		ActiveSessions:      d.ActiveSessions,
		Current:             current,
	}
}

type SessionDTO struct {
	ID         string  `json:"id"`
	DeviceID   *string `json:"deviceId"`
	DeviceName *string `json:"deviceName"`
	CreatedAt  string  `json:"createdAt"`
	LastUsedAt string  `json:"lastUsedAt"`
	ExpiresAt  string  `json:"expiresAt"`
	Current    bool    `json:"current"`
}

func (s *Session) DTO(current bool) SessionDTO {
	return SessionDTO{
		ID:         s.ID.String(),
		DeviceID:   uuidString(s.DeviceID),
		DeviceName: s.DeviceName,
		CreatedAt:  FormatTime(s.CreatedAt),
		LastUsedAt: FormatTime(s.LastUsedAt),
		ExpiresAt:  FormatTime(s.ExpiresAt),
		Current:    current,
	}
}

type SecurityEventDTO struct {
	ID        int64   `json:"id"`
	Type      string  `json:"type"`
	SessionID *string `json:"sessionId"`
	DeviceID  *string `json:"deviceId"`
	CreatedAt string  `json:"createdAt"`
}

func (e *SecurityEvent) DTO() SecurityEventDTO {
	return SecurityEventDTO{ID: e.ID, Type: e.Type, SessionID: uuidString(e.SessionID),
		DeviceID: uuidString(e.DeviceID), CreatedAt: FormatTime(e.CreatedAt)}
}

func uuidString(id *uuid.UUID) *string {
	if id == nil {
		return nil
	}
	s := id.String()
	return &s
}

func dateString(d *Date) *string {
	if d == nil {
		return nil
	}
	s := d.String()
	return &s
}
