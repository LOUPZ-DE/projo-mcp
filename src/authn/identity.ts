/**
 * Authentifizierte Identität — das Ergebnis JEDER Login-Methode.
 *
 * AUSTAUSCH-NAHTSTELLE für spätere Projekte:
 * Wer eine eigene Login-Implementierung (z. B. bestehende App-Session, LDAP,
 * anderes SSO) anbinden will, ersetzt die Erzeugung dieses Objekts und ruft
 * danach `completeAuthorization(res, pending, identity)` (src/oauth/complete.ts).
 * Der gesamte OAuth-/MCP-Pfad dahinter bleibt unverändert.
 */
export interface AuthnIdentity {
  email: string;
  name: string;
  /** Herkunft der Identität: 'local' | 'google' | 'entra' | eigener Key in späteren Projekten */
  idp: string;
}
