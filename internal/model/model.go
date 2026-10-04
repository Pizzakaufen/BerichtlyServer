package model

import (
	"time"

	"github.com/google/uuid"
)

// ReportStatus entspricht exakt `ReportStatus` der Berichtly-Android-App.
type ReportStatus string

const (
	StatusDraft     ReportStatus = "DRAFT"
	StatusGenerated ReportStatus = "GENERATED"
	StatusEdited    ReportStatus = "EDITED"
	StatusFinalized ReportStatus = "FINALIZED"
)

var ReportStatuses = []string{"DRAFT", "GENERATED", "EDITED", "FINALIZED"}

// WritingStyle entspricht `WritingStyle` der Android-App.
type WritingStyle string

var WritingStyles = []string{"NEUTRAL", "FORMAL", "SIMPLE", "DETAILED"}

type UserStatus string

const (
	UserActive   UserStatus = "ACTIVE"
	UserDisabled UserStatus = "DISABLED"
)

// User ist ein Benutzerkonto. Die ID ist stabil; die E-Mail-Adresse ist kein Schlüssel.
type User struct {
	ID           uuid.UUID
	Email        string
	PasswordHash string
	Status       UserStatus
	Timezone     string
	Locked       bool // mit der Datenbankzeit berechnet
	CreatedAt    time.Time
}

// ---------------------------------------------------------------------------
// Profil
// ---------------------------------------------------------------------------

// ProfileValues enthält genau die Profilfelder, die die Android-App kennt.
type ProfileValues struct {
	Name          string
	Profession    string
	Company       string
	Department    string
	TrainerName   string
	TrainingStart *Date
	TrainingEnd   *Date
	WritingStyle  WritingStyle
}

func (v ProfileValues) Equal(o ProfileValues) bool {
	return v.Name == o.Name && v.Profession == o.Profession && v.Company == o.Company &&
		v.Department == o.Department && v.TrainerName == o.TrainerName &&
		datePtrEqual(v.TrainingStart, o.TrainingStart) && datePtrEqual(v.TrainingEnd, o.TrainingEnd) &&
		v.WritingStyle == o.WritingStyle
}

type Profile struct {
	UserID    uuid.UUID
	Values    ProfileValues
	Version   int
	CreatedAt time.Time
	UpdatedAt time.Time
	ChangeSeq int64
}

// ---------------------------------------------------------------------------
// Tagesberichte
// ---------------------------------------------------------------------------

// DailyValues ist der Inhalt eines Tagesberichts (eine Tätigkeit an einem Arbeitstag).
type DailyValues struct {
	Date       Date
	Text       string
	Note       string
	OrderIndex int
	Status     ReportStatus
}

type DailyReport struct {
	ID        uuid.UUID
	UserID    uuid.UUID
	Values    DailyValues
	Version   int
	CreatedAt time.Time
	UpdatedAt time.Time
	DeletedAt *time.Time
	ChangeSeq int64
}

// ---------------------------------------------------------------------------
// Wochenberichte
// ---------------------------------------------------------------------------

// WeeklyValues ist der Inhalt eines Wochenberichts. Wochenende und ISO-Woche werden berechnet.
type WeeklyValues struct {
	Week        IsoWeek
	Content     string
	Status      ReportStatus
	GeneratedAt *time.Time
}

func (v WeeklyValues) Equal(o WeeklyValues) bool {
	if v.Week != o.Week || v.Content != o.Content || v.Status != o.Status {
		return false
	}
	if (v.GeneratedAt == nil) != (o.GeneratedAt == nil) {
		return false
	}
	return v.GeneratedAt == nil || v.GeneratedAt.Equal(*o.GeneratedAt)
}

type WeeklyReport struct {
	ID        uuid.UUID
	UserID    uuid.UUID
	Values    WeeklyValues
	Version   int
	CreatedAt time.Time
	UpdatedAt time.Time
	DeletedAt *time.Time
	ChangeSeq int64
}

// ---------------------------------------------------------------------------
// Geräte
// ---------------------------------------------------------------------------

type DeviceInfo struct {
	DeviceID   uuid.UUID
	Name       string
	Platform   string
	AppVersion string
}

type Device struct {
	Ref            uuid.UUID // server-interne Referenz
	UserID         uuid.UUID
	DeviceID       uuid.UUID // stabile, vom Client erzeugte Geräte-ID
	Name           string
	Platform       string
	AppVersion     string
	CreatedAt      time.Time
	LastSeenAt     time.Time
	LastPullAt     *time.Time
	LastPullCursor *int64
	LastPushAt     *time.Time
	ActiveSessions int
}

func datePtrEqual(a, b *Date) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}
