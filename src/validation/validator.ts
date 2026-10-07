// Feldweise Validierung mit stabilen Fehlercodes (z. B. "too_long:max=5000").
// Zusätzlich typsichere Lesefunktionen für JSON-Bodies: Ein falscher JSON-Typ (z. B. Zahl statt Text)
// führt – wie in 1.0/1.1 – zu 400 INVALID_REQUEST_BODY, fehlende Felder zu feldgenauen 422-Fehlern.

import { ApiError, type FieldError, invalidBody, validationError } from '../domain/errors.ts';
import { dateInRange, parseDate } from '../domain/date.ts';

const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/;

/** Kanonische UUID (kleingeschrieben) oder null. */
export const parseUuid = (s: string): string | null => (UUID_PATTERN.test(s) ? s.toLowerCase() : null);

export const codePointLength = (s: string) => {
  let n = 0;
  for (const _ of s) n++;
  return n;
};

// ---------------------------------------------------------------------------
// Lesen von JSON-Feldern (undefined und null gelten als "nicht angegeben")
// ---------------------------------------------------------------------------

export type Json = Record<string, unknown>;

/** Der Body muss ein JSON-Objekt sein. */
export function asObject(value: unknown): Json {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalidBody();
  return value as Json;
}

export function optString(o: Json, key: string): string | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw invalidBody();
  return v;
}

export function optInt(o: Json, key: string): number | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || Math.abs(v) > 2 ** 31) throw invalidBody();
  return v;
}

export function optObject(o: Json, key: string): Json | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  return asObject(v);
}

export function optArray(o: Json, key: string): unknown[] | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) throw invalidBody();
  return v;
}

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

export interface TextOpts {
  max: number;
  required?: boolean;
  notBlank?: boolean;
  singleLine?: boolean;
  def?: string;
}

export class Validator {
  private readonly errors: FieldError[] = [];

  add(field: string, issue: string) {
    this.errors.push({ field, issue });
  }

  check(ok: boolean, field: string, issue: string) {
    if (!ok) this.add(field, issue);
  }

  get ok() {
    return this.errors.length === 0;
  }

  get list(): FieldError[] {
    return [...this.errors];
  }

  /** Wirft einen Validierungsfehler, falls Fehler gesammelt wurden. */
  throwIfInvalid() {
    if (!this.ok) throw validationError(this.list);
  }

  error(): ApiError | null {
    return this.ok ? null : validationError(this.list);
  }

  uuid(field: string, value: string | undefined, required = true): string | null {
    if (value === undefined) {
      if (required) this.add(field, 'required');
      return null;
    }
    const id = parseUuid(value);
    if (!id) this.add(field, 'invalid_uuid');
    return id;
  }

  /** Datum im Bereich 2000-01-01 bis 2100-12-31. undefined = nicht angegeben (ok, wenn optional). */
  date(field: string, value: string | undefined, required: boolean): string | null {
    if (value === undefined) {
      if (required) this.add(field, 'required');
      return null;
    }
    const d = parseDate(value);
    if (!d) {
      this.add(field, 'invalid_date');
      return null;
    }
    if (!dateInRange(d)) {
      this.add(field, 'out_of_range');
      return null;
    }
    return d;
  }

  /** ISO-8601-Zeitpunkt mit Zeitzone, auf Millisekunden gekürzt. */
  timestamp(field: string, value: string | undefined): Date | null {
    if (value === undefined) return null;
    const ms = TIMESTAMP_PATTERN.test(value) ? Date.parse(value) : Number.NaN;
    if (Number.isNaN(ms)) {
      this.add(field, 'invalid_timestamp');
      return null;
    }
    return new Date(ms);
  }

  /** Prüft Länge (in Zeichen), NUL-Zeichen, ungültige Zeichenfolgen und bei einzeiligen Feldern Steuerzeichen. */
  text(field: string, value: string | undefined, o: TextOpts): string | null {
    if (value === undefined) {
      if (o.required) {
        this.add(field, 'required');
        return null;
      }
      return o.def ?? '';
    }
    if (!value.isWellFormed()) this.add(field, 'invalid_characters');
    else if (codePointLength(value) > o.max) this.add(field, `too_long:max=${o.max}`);
    else if (o.notBlank && value.trim() === '') this.add(field, 'blank');
    else if (value.includes('\u0000')) this.add(field, 'invalid_characters');
    else if (o.singleLine && CONTROL_CHARS.test(value)) this.add(field, 'invalid_characters');
    else return value;
    return null;
  }

  int(field: string, value: number | undefined, min: number, max: number, def: number, required: boolean): number | null {
    if (value === undefined) {
      if (required) {
        this.add(field, 'required');
        return null;
      }
      return def;
    }
    if (value < min || value > max) {
      this.add(field, `out_of_range:${min}..${max}`);
      return null;
    }
    return value;
  }

  enumValue(field: string, value: string | undefined, allowed: readonly string[], def: string): string | null {
    if (value === undefined) return def;
    if (!allowed.includes(value)) {
      this.add(field, `invalid_value:${allowed.join('|')}`);
      return null;
    }
    return value;
  }

  /** IANA-Zeitzone der Form Region/Ort (z. B. Europe/Berlin). */
  timezone(field: string, value: string | undefined): string | null {
    if (value === undefined) return null;
    if (isValidTimezone(value)) return value;
    this.add(field, 'invalid_timezone');
    return null;
  }
}

export function isValidTimezone(tz: string): boolean {
  if (!tz.includes('/') || tz.includes('..') || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
