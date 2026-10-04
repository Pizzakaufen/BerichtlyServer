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
	CreatedAt time.Time // Serverzeit
	UpdatedAt time.Time // Serverzeit
	DeletedAt *time.Time
	ChangeSeq int64
	Origin    Origin
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
	CreatedAt time.Time // Serverzeit
	UpdatedAt time.Time // Serverzeit
	DeletedAt *time.Time
	ChangeSeq int64
	Origin    Origin
}

// ---------------------------------------------------------------------------
// Geräte
// ---------------------------------------------------------------------------

// DeviceInfo sind die vom Gerät gemeldeten Angaben. Bewusst keine Hardware-Kennungen,
// Seriennummern oder Standortdaten.
type DeviceInfo struct {
	DeviceID   uuid.UUID
	Name       string
	Platform   string
	OSVersion  string
	AppVersion string
}

// SyncStatus eines Geräts.
type SyncStatus string

const (
	SyncNever    SyncStatus = "NEVER"    // noch nie eine Synchronisierung abgeschlossen
	SyncSuccess  SyncStatus = "SUCCESS"  // letzte Synchronisierung erfolgreich
	SyncFailed   SyncStatus = "FAILED"   // letzte Synchronisierung fehlgeschlagen
	SyncConflict SyncStatus = "CONFLICT" // abgeschlossen, aber mit ungelösten Konflikten
)

type Device struct {
	Ref                  uuid.UUID // server-interne Referenz
	UserID               uuid.UUID
	DeviceID             uuid.UUID // stabile, vom Client erzeugte Geräte-ID
	Name                 string
	Platform             string
	OSVersion            string
	AppVersion           string
	CreatedAt            time.Time
	LastSeenAt           time.Time
	RevokedAt            *time.Time
	LastPullAt           *time.Time
	LastPullCursor       *int64
	LastPushAt           *time.Time
	SyncStatus           SyncStatus
	LastSyncStartedAt    *time.Time
	LastSuccessfulSyncAt *time.Time
	LastSuccessfulCursor *int64
	LastFailedSyncAt     *time.Time
	LastSyncErrorCode    *string
	UnresolvedConflicts  int
	ActiveSessions       int
}

// Origin beschreibt die Herkunft der letzten Änderung eines Berichts. Clientzeit und lokale ID
// sind reine Zusatzinformationen; maßgeblich sind immer Serverzeit, Version und Änderungsnummer.
type Origin struct {
	ClientUpdatedAt   *time.Time
	ClientLocalID     *string
	CreatedByDeviceID *uuid.UUID // stabile Geräte-ID (nicht die interne Referenz)
	LastDeviceID      *uuid.UUID
	LastOperationID   *uuid.UUID
}

// WriteMeta begleitet eine Schreiboperation (Gerät, Operation, Clientangaben).
type WriteMeta struct {
	DeviceRef       *uuid.UUID
	OperationID     *uuid.UUID
	ClientUpdatedAt *time.Time
	ClientLocalID   *string
}

// Session ist eine Anmeldung (für die Sitzungsübersicht).
type Session struct {
	ID         uuid.UUID
	DeviceID   *uuid.UUID
	DeviceName *string
	CreatedAt  time.Time
	LastUsedAt time.Time
	ExpiresAt  time.Time
}

// SecurityEvent ist ein technisches Sicherheitsereignis ohne Inhalte.
type SecurityEvent struct {
	ID        int64
	Type      string
	SessionID *uuid.UUID
	DeviceID  *uuid.UUID
	CreatedAt time.Time
}

func datePtrEqual(a, b *Date) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}
