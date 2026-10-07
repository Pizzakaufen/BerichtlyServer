// Kalenderdaten (YYYY-MM-DD) ohne Uhrzeit und Zeitzone sowie ISO-Wochen (Montag–Sonntag).
// Berichtsdaten werden in der Zeitzone des Benutzers interpretiert, nie in der des Servers.
// Intern wird ausschließlich mit UTC-Mitternacht gerechnet, damit Sommer-/Winterzeit keine Rolle spielt.

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

export const MIN_DATE = '2000-01-01';
export const MAX_DATE = '2100-12-31';

/** Prüft streng auf YYYY-MM-DD mit gültigem Kalenderdatum. */
export function parseDate(s: string): string | null {
  const m = DATE_PATTERN.exec(s);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null;
  return s;
}

export const dateInRange = (d: string) => d >= MIN_DATE && d <= MAX_DATE;

const toUtc = (d: string) => Date.parse(`${d}T00:00:00Z`);
const fromUtc = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export const addDays = (d: string, n: number) => fromUtc(toUtc(d) + n * DAY_MS);

/** Wochentag: 0 = Montag … 6 = Sonntag. */
export const isoWeekday = (d: string) => (new Date(toUtc(d)).getUTCDay() + 6) % 7;

const WEEKDAY_NAMES = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'];
export const weekdayName = (d: string) => WEEKDAY_NAMES[isoWeekday(d)];

/** Montag der Woche, die das Datum enthält. */
export const weekStartOf = (d: string) => addDays(d, -isoWeekday(d));

/** ISO-Jahr und ISO-Woche eines Datums. */
export function isoWeekOf(d: string): { year: number; week: number } {
  // Donnerstag derselben Woche bestimmt das ISO-Jahr.
  const thursday = addDays(d, 3 - isoWeekday(d));
  const year = Number(thursday.slice(0, 4));
  // Woche 1 beginnt am Montag der Woche, die den 4. Januar enthält.
  const week1Monday = weekStartOf(`${String(year).padStart(4, '0')}-01-04`);
  const week = 1 + Math.round((toUtc(thursday) - 3 * DAY_MS - toUtc(week1Monday)) / (7 * DAY_MS));
  return { year, week };
}

export interface IsoWeek {
  start: string;
  end: string;
  year: number;
  week: number;
}

export function weekContaining(d: string): IsoWeek {
  const start = weekStartOf(d);
  const { year, week } = isoWeekOf(start);
  return { start, end: addDays(start, 6), year, week };
}

/** ISO-Woche aus Jahr und Nummer; null, wenn es sie nicht gibt (z. B. Woche 53 in 52-Wochen-Jahren). */
export function isoWeekFromNumber(year: number, week: number): IsoWeek | null {
  if (!Number.isInteger(year) || !Number.isInteger(week) || week < 1 || week > 53) return null;
  if (year < Number(MIN_DATE.slice(0, 4)) || year > Number(MAX_DATE.slice(0, 4))) return null;
  const w = weekContaining(`${String(year).padStart(4, '0')}-01-04`); // 4. Januar liegt immer in Woche 1
  const result = weekContaining(addDays(w.start, (week - 1) * 7));
  return result.year === year && result.week === week ? result : null;
}

export const weekDays = (w: IsoWeek) => Array.from({ length: 7 }, (_, i) => addDays(w.start, i));

/** Erster und letzter Tag eines Monats (month 1–12). */
export function monthRange(year: number, month: number): [string, string] {
  const first = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-01`;
  return [first, fromUtc(Date.UTC(year, month, 0))];
}

/** Kalenderdatum eines Zeitpunkts in einer IANA-Zeitzone (DST-sicher über Intl). */
export function todayIn(now: Date, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' })
      .format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/** Zeitpunkte einheitlich als UTC ISO-8601 mit Millisekunden. */
export const formatTime = (t: Date) => t.toISOString();
export const formatTimeOrNull = (t: Date | null | undefined) => (t ? t.toISOString() : null);
