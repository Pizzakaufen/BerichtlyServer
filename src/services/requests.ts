// Lesen und Validieren von Request-Inhalten. Dieselben Funktionen nutzen REST-Endpunkte und Synchronisierung.
// Servergenerierte Felder (createdAt, updatedAt, deleted, userId …) werden nie aus Requests übernommen.

import { isoWeekday, weekContaining } from '../domain/date.ts';
import {
  type DailyValues, type ProfileValues, REPORT_STATUSES, type ReportStatus, type WeeklyValues, type WriteMeta,
  WRITING_STYLES, type WritingStyle,
} from '../domain/models.ts';
import { type Json, optInt, optString, Validator } from '../validation/validator.ts';

// Feldgrenzen (siehe docs/API.md)
export const DAILY_TEXT_MAX = 5000;
export const DAILY_NOTE_MAX = 2000;
export const ORDER_INDEX_MAX = 10000;
export const WEEKLY_CONTENT_MAX = 50000;
const CLIENT_LOCAL_ID = /^[A-Za-z0-9._:-]{1,64}$/;

/**
 * Optionale Clientangaben (clientUpdatedAt, clientLocalId) einer Änderung. Sie werden gespeichert und
 * zurückgegeben, aber nie für Entscheidungen verwendet – der Server vertraut der Geräteuhr nicht.
 */
export function readMeta(o: Json, v: Validator, deviceRef: string | null, operationId: string | null): WriteMeta {
  const clientUpdatedAt = v.timestamp('clientUpdatedAt', optString(o, 'clientUpdatedAt'));
  const localId = optString(o, 'clientLocalId');
  let clientLocalId: string | null = null;
  if (localId !== undefined) {
    if (CLIENT_LOCAL_ID.test(localId)) clientLocalId = localId;
    else v.add('clientLocalId', 'invalid_value:[A-Za-z0-9._:-]{1,64}');
  }
  return { deviceRef, operationId, clientUpdatedAt, clientLocalId };
}

export function readDailyValues(o: Json, v: Validator): DailyValues {
  const date = v.date('date', optString(o, 'date'), true);
  const text = v.text('text', optString(o, 'text'), { max: DAILY_TEXT_MAX, required: true, notBlank: true });
  const note = v.text('note', optString(o, 'note'), { max: DAILY_NOTE_MAX });
  const orderIndex = v.int('orderIndex', optInt(o, 'orderIndex'), 0, ORDER_INDEX_MAX, 0, false);
  const status = v.enumValue('status', optString(o, 'status'), REPORT_STATUSES, 'DRAFT');
  return { date: date ?? '', text: text ?? '', note: note ?? '', orderIndex: orderIndex ?? 0,
    status: (status ?? 'DRAFT') as ReportStatus };
}

export function readWeeklyValues(o: Json, v: Validator): WeeklyValues {
  const start = v.date('weekStart', optString(o, 'weekStart'), true);
  if (start && isoWeekday(start) !== 0) v.add('weekStart', 'must_be_monday');
  const content = v.text('content', optString(o, 'content'), { max: WEEKLY_CONTENT_MAX });
  const status = v.enumValue('status', optString(o, 'status'), REPORT_STATUSES, 'DRAFT');
  const generatedAt = v.timestamp('generatedAt', optString(o, 'generatedAt'));
  return {
    week: weekContaining(start ?? '2000-01-03'),
    content: content ?? '',
    status: (status ?? 'DRAFT') as ReportStatus,
    generatedAt,
  };
}

/** Vollständiger Profilinhalt (PUT ersetzt alle Felder; nicht gesendete Textfelder werden geleert). */
export function readProfileValues(o: Json, v: Validator): ProfileValues {
  const line = (field: string, max: number) => {
    const raw = optString(o, field);
    return v.text(field, raw?.trim(), { max, singleLine: true }) ?? '';
  };
  const values: ProfileValues = {
    name: line('name', 120),
    profession: line('profession', 120),
    company: line('company', 160),
    department: line('department', 120),
    trainerName: line('trainerName', 120),
    trainingStart: v.date('trainingStart', optString(o, 'trainingStart'), false),
    trainingEnd: v.date('trainingEnd', optString(o, 'trainingEnd'), false),
    writingStyle: (v.enumValue('writingStyle', optString(o, 'writingStyle'), WRITING_STYLES, 'NEUTRAL') ?? 'NEUTRAL') as WritingStyle,
  };
  if (values.trainingStart && values.trainingEnd && values.trainingEnd < values.trainingStart) {
    v.add('trainingEnd', 'before_training_start');
  }
  return values;
}
