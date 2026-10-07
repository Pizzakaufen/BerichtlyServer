// Fachliche Fehler mit stabilen, maschinenlesbaren Fehlercodes (Teil der API).
// Die HTTP-Schicht übersetzt sie in die einheitliche JSON-Fehlerstruktur.

export const Codes = {
  ValidationFailed: 'VALIDATION_FAILED',
  InvalidRequestBody: 'INVALID_REQUEST_BODY',
  InvalidParameter: 'INVALID_PARAMETER',
  Unauthorized: 'UNAUTHORIZED',
  InvalidCredentials: 'INVALID_CREDENTIALS',
  InvalidRefreshToken: 'INVALID_REFRESH_TOKEN',
  AccountDisabled: 'ACCOUNT_DISABLED',
  AccountTemporarilyLocked: 'ACCOUNT_TEMPORARILY_LOCKED',
  RegistrationDisabled: 'REGISTRATION_DISABLED',
  EmailAlreadyRegistered: 'EMAIL_ALREADY_REGISTERED',
  NotFound: 'NOT_FOUND',
  MethodNotAllowed: 'METHOD_NOT_ALLOWED',
  Conflict: 'CONFLICT',
  PayloadTooLarge: 'PAYLOAD_TOO_LARGE',
  UnsupportedMediaType: 'UNSUPPORTED_MEDIA_TYPE',
  RateLimited: 'RATE_LIMITED',
  InternalError: 'INTERNAL_ERROR',
  ServiceUnavailable: 'SERVICE_UNAVAILABLE',
  SyncCursorExpired: 'SYNC_CURSOR_EXPIRED',
  DeviceRequired: 'DEVICE_REQUIRED',
  OperationIdReused: 'OPERATION_ID_REUSED',
} as const;

export type ConflictReason =
  | 'VERSION_MISMATCH' // seit der Basisversion des Clients auf dem Server geändert
  | 'DELETED_ON_SERVER' // auf dem Server gelöscht
  | 'ALREADY_EXISTS' // ID existiert bereits mit anderem Inhalt
  | 'DUPLICATE_WEEK' // für diese Woche existiert bereits ein anderer Wochenbericht
  | 'ID_UNAVAILABLE'; // ID gehört z. B. einem anderen Konto

export interface FieldError {
  field: string;
  issue: string;
}

export interface ConflictInfo {
  reason: ConflictReason;
  serverVersion: number | null;
  serverRecord: unknown;
}

/** Fachlicher Fehler mit HTTP-Status. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: FieldError[] | null;
  readonly conflict: ConflictInfo | null;

  constructor(status: number, code: string, message: string, details: FieldError[] | null = null,
    conflict: ConflictInfo | null = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.conflict = conflict;
  }
}

export const validationError = (details: FieldError[]) =>
  new ApiError(422, Codes.ValidationFailed, 'Die Eingabedaten sind ungültig.', details);

export const badParameter = (field: string, issue: string) =>
  new ApiError(400, Codes.InvalidParameter, 'Ungültiger Parameter.', [{ field, issue }]);

export const notFound = (what: string) => new ApiError(404, Codes.NotFound, `${what} wurde nicht gefunden.`);

export const conflictError = (info: ConflictInfo) =>
  new ApiError(409, Codes.Conflict, 'Der Datensatz wurde zwischenzeitlich geändert. Es wurde nichts überschrieben.',
    null, info);

export const unauthorized = () =>
  new ApiError(401, Codes.Unauthorized, 'Authentifizierung erforderlich oder Access Token ungültig/abgelaufen.');

export const invalidBody = () =>
  new ApiError(400, Codes.InvalidRequestBody, 'Der Request-Body ist kein gültiges JSON oder hat eine falsche Struktur.');
