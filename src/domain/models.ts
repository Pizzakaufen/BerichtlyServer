// Domänentypen und ihre JSON-Darstellung (Feldnamen camelCase, Zeitpunkte UTC mit Millisekunden).
// Die Darstellung ist identisch mit Berichtly Server 1.1 (Kompatibilität der API /api/v1).

import { formatTime, formatTimeOrNull, type IsoWeek, weekContaining } from './date.ts';

export const REPORT_STATUSES = ['DRAFT', 'GENERATED', 'EDITED', 'FINALIZED'] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];
export const WRITING_STYLES = ['NEUTRAL', 'FORMAL', 'SIMPLE', 'DETAILED'] as const;
export type WritingStyle = (typeof WRITING_STYLES)[number];
export type SyncStatus = 'NEVER' | 'SUCCESS' | 'FAILED' | 'CONFLICT';

export interface User {
  id: string;
  email: string;
  passwordHash: string;
  status: 'ACTIVE' | 'DISABLED';
  timezone: string;
  locked: boolean; // mit der Datenbankzeit berechnet
  createdAt: Date;
}

export const accountDto = (u: User) => ({
  id: u.id, email: u.email, timezone: u.timezone, createdAt: formatTime(u.createdAt),
});

// ---------------------------------------------------------------------------
// Profil
// ---------------------------------------------------------------------------

export interface ProfileValues {
  name: string;
  profession: string;
  company: string;
  department: string;
  trainerName: string;
  trainingStart: string | null;
  trainingEnd: string | null;
  writingStyle: WritingStyle;
}

export interface Profile {
  userId: string;
  values: ProfileValues;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  changeSeq: number;
}

export const profileValuesEqual = (a: ProfileValues, b: ProfileValues) =>
  a.name === b.name && a.profession === b.profession && a.company === b.company && a.department === b.department &&
  a.trainerName === b.trainerName && a.trainingStart === b.trainingStart && a.trainingEnd === b.trainingEnd &&
  a.writingStyle === b.writingStyle;

export const profileDto = (p: Profile) => ({
  id: p.userId,
  name: p.values.name,
  profession: p.values.profession,
  company: p.values.company,
  department: p.values.department,
  trainerName: p.values.trainerName,
  trainingStart: p.values.trainingStart,
  trainingEnd: p.values.trainingEnd,
  writingStyle: p.values.writingStyle,
  version: p.version,
  createdAt: formatTime(p.createdAt),
  updatedAt: formatTime(p.updatedAt),
});

// ---------------------------------------------------------------------------
// Herkunft (Clientzeit, lokale ID, Geräte, Operation) – nur informativ
// ---------------------------------------------------------------------------

export interface Origin {
  clientUpdatedAt: Date | null;
  clientLocalId: string | null;
  createdByDeviceId: string | null; // stabile Geräte-ID (nicht die interne Referenz)
  lastDeviceId: string | null;
  lastOperationId: string | null;
}

/** Metadaten einer Schreiboperation. */
export interface WriteMeta {
  deviceRef: string | null;
  operationId: string | null;
  clientUpdatedAt: Date | null;
  clientLocalId: string | null;
}

export const emptyMeta = (deviceRef: string | null = null): WriteMeta =>
  ({ deviceRef, operationId: null, clientUpdatedAt: null, clientLocalId: null });

const originDto = (o: Origin) => ({
  clientUpdatedAt: formatTimeOrNull(o.clientUpdatedAt),
  clientLocalId: o.clientLocalId,
  createdByDeviceId: o.createdByDeviceId,
  lastModifiedByDeviceId: o.lastDeviceId,
  lastOperationId: o.lastOperationId,
});

// ---------------------------------------------------------------------------
// Tagesberichte
// ---------------------------------------------------------------------------

export interface DailyValues {
  date: string;
  text: string;
  note: string;
  orderIndex: number;
  status: ReportStatus;
}

export interface DailyReport {
  id: string;
  userId: string;
  values: DailyValues;
  version: number;
  createdAt: Date; // Serverzeit
  updatedAt: Date; // Serverzeit
  deletedAt: Date | null;
  changeSeq: number;
  origin: Origin;
}

export const dailyValuesEqual = (a: DailyValues, b: DailyValues) =>
  a.date === b.date && a.text === b.text && a.note === b.note && a.orderIndex === b.orderIndex && a.status === b.status;

export const dailyDto = (r: DailyReport) => ({
  id: r.id,
  date: r.values.date,
  text: r.values.text,
  note: r.values.note,
  orderIndex: r.values.orderIndex,
  status: r.values.status,
  version: r.version,
  createdAt: formatTime(r.createdAt),
  updatedAt: formatTime(r.updatedAt),
  deleted: r.deletedAt !== null,
  deletedAt: formatTimeOrNull(r.deletedAt),
  ...originDto(r.origin),
});

// ---------------------------------------------------------------------------
// Wochenberichte
// ---------------------------------------------------------------------------

export interface WeeklyValues {
  week: IsoWeek;
  content: string;
  status: ReportStatus;
  generatedAt: Date | null;
}

export interface WeeklyReport {
  id: string;
  userId: string;
  values: WeeklyValues;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  changeSeq: number;
  origin: Origin;
}

export const weeklyValuesEqual = (a: WeeklyValues, b: WeeklyValues) =>
  a.week.start === b.week.start && a.content === b.content && a.status === b.status &&
  (a.generatedAt?.getTime() ?? null) === (b.generatedAt?.getTime() ?? null);

export const weekOf = (start: string) => weekContaining(start);

export const weeklyDto = (r: WeeklyReport) => ({
  id: r.id,
  weekStart: r.values.week.start,
  weekEnd: r.values.week.end,
  isoYear: r.values.week.year,
  isoWeek: r.values.week.week,
  content: r.values.content,
  status: r.values.status,
  generatedAt: formatTimeOrNull(r.values.generatedAt),
  version: r.version,
  createdAt: formatTime(r.createdAt),
  updatedAt: formatTime(r.updatedAt),
  deleted: r.deletedAt !== null,
  deletedAt: formatTimeOrNull(r.deletedAt),
  ...originDto(r.origin),
});

// ---------------------------------------------------------------------------
// Geräte, Sitzungen, Sicherheitsereignisse
// ---------------------------------------------------------------------------

/** Vom Gerät gemeldete Angaben – bewusst keine Hardware-Kennungen oder Standortdaten. */
export interface DeviceInfo {
  deviceId: string;
  name: string;
  platform: string;
  osVersion: string;
  appVersion: string;
}

export interface Device {
  ref: string; // server-interne Referenz
  userId: string;
  deviceId: string; // stabile, vom Client erzeugte Geräte-ID
  name: string;
  platform: string;
  osVersion: string;
  appVersion: string;
  createdAt: Date;
  lastSeenAt: Date;
  revokedAt: Date | null;
  lastPullAt: Date | null;
  lastPullCursor: number | null;
  lastPushAt: Date | null;
  syncStatus: SyncStatus;
  lastSyncStartedAt: Date | null;
  lastSuccessfulSyncAt: Date | null;
  lastSuccessfulCursor: number | null;
  lastFailedSyncAt: Date | null;
  lastSyncErrorCode: string | null;
  unresolvedConflicts: number;
  activeSessions: number;
}

export const deviceDto = (d: Device, current: boolean) => ({
  id: d.deviceId,
  name: d.name,
  platform: d.platform,
  osVersion: d.osVersion,
  appVersion: d.appVersion,
  createdAt: formatTime(d.createdAt),
  lastSeenAt: formatTime(d.lastSeenAt),
  revokedAt: formatTimeOrNull(d.revokedAt),
  syncStatus: d.syncStatus,
  lastSyncAt: formatTimeOrNull(d.lastSuccessfulSyncAt),
  lastSyncStartedAt: formatTimeOrNull(d.lastSyncStartedAt),
  lastFailedSyncAt: formatTimeOrNull(d.lastFailedSyncAt),
  lastSyncErrorCode: d.lastSyncErrorCode,
  unresolvedConflicts: d.unresolvedConflicts,
  lastPullAt: formatTimeOrNull(d.lastPullAt),
  lastPushAt: formatTimeOrNull(d.lastPushAt),
  activeSessions: d.activeSessions,
  current,
});

export interface Session {
  id: string;
  deviceId: string | null;
  deviceName: string | null;
  createdAt: Date;
  lastUsedAt: Date;
  expiresAt: Date;
}

export const sessionDto = (s: Session, current: boolean) => ({
  id: s.id,
  deviceId: s.deviceId,
  deviceName: s.deviceName,
  createdAt: formatTime(s.createdAt),
  lastUsedAt: formatTime(s.lastUsedAt),
  expiresAt: formatTime(s.expiresAt),
  current,
});

export interface SecurityEvent {
  id: number;
  type: string;
  sessionId: string | null;
  deviceId: string | null;
  createdAt: Date;
}

export const securityEventDto = (e: SecurityEvent) => ({
  id: e.id, type: e.type, sessionId: e.sessionId, deviceId: e.deviceId, createdAt: formatTime(e.createdAt),
});
