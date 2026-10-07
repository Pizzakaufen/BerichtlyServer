// Strukturiertes Logging (JSON in Produktion, lesbarer Text in Entwicklung), Zeitstempel immer UTC.
// Es werden nie Passwörter, Tokens, Request-Bodies oder Berichtsinhalte geloggt – nur technische Felder.

export type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

export function createLogger(level: Level, format: 'text' | 'json', out: (line: string) => void = (l) => {
  process.stdout.write(l + '\n');
}, base: Record<string, unknown> = {}): Logger {
  const min = ORDER[level];
  const write = (lvl: Level, msg: string, fields?: Record<string, unknown>) => {
    if (ORDER[lvl] < min) return;
    const entry = { time: new Date().toISOString(), level: lvl.toUpperCase(), msg, ...base, ...fields };
    if (format === 'json') {
      out(JSON.stringify(entry));
    } else {
      const extra = Object.entries({ ...base, ...fields }).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`);
      out(`${entry.time} ${entry.level.padEnd(5)} ${msg}${extra.length ? ' ' + extra.join(' ') : ''}`);
    }
  };
  return {
    debug: (m, f) => write('debug', m, f),
    info: (m, f) => write('info', m, f),
    warn: (m, f) => write('warn', m, f),
    error: (m, f) => write('error', m, f),
    child: (fields) => createLogger(level, format, out, { ...base, ...fields }),
  };
}

export const silentLogger = (): Logger => createLogger('error', 'json', () => {});
