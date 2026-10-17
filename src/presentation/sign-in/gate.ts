import type { Identity } from '#application/sign-in/identity.ts';

/** What happens to an API request once its caller is known. */
export type GateDecision =
  | { readonly kind: 'reject'; readonly status: number; readonly body: { readonly error: string; readonly code?: string } }
  /**
   * Let it through, acting as `actAs`: a member id (the signed-in member or the token's), `null`
   * to drop any "acting as" the browser sent, or `'as-sent'` to keep it (sign-in off).
   */
  | { readonly kind: 'pass'; readonly actAs: string | null | 'as-sent' };

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/**
 * Reachable without signing in, so people can sign in, and GitHub can deliver webhooks (which are
 * signed instead). Paths are relative to /api.
 */
const PUBLIC_PATHS = new Set(['/auth/status', '/auth/login', '/auth/password', '/auth/logout', '/integrations/github/webhook', '/integrations/github/webhook/']);

/**
 * With sign-in on, requests need a valid session; API tokens work whether or not it is on, and
 * read-only ones can't change anything. History and comments are attributed to who actually
 * made the change, never to what the browser claims.
 */
export function gate(identity: Identity, method: string, path: string): GateDecision {
  if (identity.invalidToken) return { kind: 'reject', status: 401, body: { error: 'Invalid or expired API token', code: 'token' } };
  if (identity.via === 'token' && identity.member) {
    if (identity.token?.scope === 'read' && MUTATING.has(method)) return { kind: 'reject', status: 403, body: { error: 'This API token is read-only' } };
    return { kind: 'pass', actAs: identity.member.id };
  }
  if (!identity.signInEnabled) return { kind: 'pass', actAs: 'as-sent' };
  if (identity.member) return { kind: 'pass', actAs: identity.member.id };
  if (PUBLIC_PATHS.has(path.toLowerCase())) return { kind: 'pass', actAs: null };
  return { kind: 'reject', status: 401, body: { error: 'Please sign in', code: 'signin' } };
}
