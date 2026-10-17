import type { ApiTokenInfo } from '#domain/api-tokens/api-token.ts';
import type { Member } from '#domain/types.ts';

/** Who a request comes from, worked out from its session cookie or API token. */
export interface Identity {
  /** Sign-in is on (and not forced off). */
  readonly signInEnabled: boolean;
  /** The signed-in member, or the member an API token acts as. */
  readonly member: Member | null;
  readonly isAdmin: boolean;
  readonly via: 'session' | 'token' | 'none';
  /** The API token used, if any. */
  readonly token: ApiTokenInfo | null;
  /** An API token was presented but is unknown, expired or revoked. */
  readonly invalidToken: boolean;
}
