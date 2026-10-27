import type { JWTPayload, JWTVerifyGetKey } from 'jose';

/** Identität, wie sie ein externer Identity Provider liefert (nach Claim-Mapping). */
export interface IdpIdentity {
  providerKey: string;
  subject: string; // OIDC sub
  email: string;
  name: string;
  /** Roh-Claims (für Logging/Debug) */
  raw: JWTPayload;
}

/**
 * Ein externer Identity Provider (OIDC, Authorization Code + PKCE).
 * Neue Provider = neues Objekt dieses Typs + Eintrag in der Registry.
 */
export interface IdpProvider {
  /** URL-Schlüssel, z. B. 'google' | 'entra' — bestimmt /auth/<key>/start|callback */
  key: string;
  /** Anzeigename auf dem Login-Button ('Google', 'Microsoft') */
  displayName: string;
  /** Erwarteter iss im id_token (string[] für IdPs mit historischen Varianten) */
  issuer: string | string[];
  authorizationEndpoint: string;
  tokenEndpoint: string;
  /** Remote-JWKS-Set (jose cached intern) */
  jwks: JWTVerifyGetKey;
  clientId: string;
  clientSecret: string;
  scope: string;
  /** Claims → IdpIdentity; null, wenn keine brauchbare E-Mail ermittelbar */
  mapClaims(claims: JWTPayload): IdpIdentity | null;
}
