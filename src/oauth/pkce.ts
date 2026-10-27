import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;

/** Zufalls-Token (base64url) für client_id, auth codes, refresh tokens, txn ids. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** RFC 7636 §4.6: BASE64URL-ENCODE(SHA256(verifier)) === challenge */
export function verifyS256(verifier: string, challenge: string): boolean {
  if (!VERIFIER_RE.test(verifier)) return false;
  const computed = createHash('sha256').update(verifier).digest('base64url');
  const a = Buffer.from(computed);
  const b = Buffer.from(challenge);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** S256-Challenge zu einem Verifier berechnen (für ausgehende PKCE-Flows, z. B. zum IdP). */
export function s256Challenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}
