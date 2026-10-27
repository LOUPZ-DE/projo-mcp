/**
 * Fehler-Vokabular der Projo-Schicht. Die Codes landen 1:1 im Tool-Ergebnis
 * (`{ error: { code, message } }`), damit der MCP-Client gezielt reagieren kann.
 */
export type ProjoErrorCode =
  /** Für diesen MCP-Nutzer ist noch keine Projo-Sitzung hinterlegt */
  | 'projo_not_connected'
  /** Sitzung abgelaufen und keine stille Neuanmeldung möglich → /connect */
  | 'projo_login_required'
  /** Anmeldung bei Projo fehlgeschlagen (falsches Passwort, SSO-Pflicht, MFA abgelehnt …) */
  | 'projo_login_failed'
  /** Projo verweigert den Zugriff (fehlende Rolle/Rechte) */
  | 'projo_forbidden'
  /** Projo hat die Eingabe abgelehnt (422 / Formularfehler) */
  | 'validation_failed'
  /** Seite/Formular sieht anders aus als erwartet (UI-Änderung) */
  | 'drift_detected'
  /** Projo nicht erreichbar / 5xx / Timeout */
  | 'projo_unavailable'
  | 'not_found'
  | 'invalid_input'
  /** Pfad/Aktion ist aus Sicherheitsgründen gesperrt */
  | 'blocked';

export class ProjoError extends Error {
  constructor(
    readonly code: ProjoErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ProjoError';
  }
}

export const isProjoError = (err: unknown): err is ProjoError => err instanceof ProjoError;

/** Projo hat auf /login umgeleitet (oder die Login-Seite ausgeliefert). */
export class SessionExpiredError extends ProjoError {
  constructor(message = 'Die Projo-Sitzung ist abgelaufen.') {
    super('projo_login_required', message);
    this.name = 'SessionExpiredError';
  }
}
