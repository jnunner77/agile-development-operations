/**
 * Whether the caller may administer the project (team, settings). With sign-in off everyone may;
 * API tokens never may.
 */
export type AdminAccess = 'granted' | 'token' | 'not-admin';

/** Who is asking, as established by the delivery layer (sign-in, API token or X-User header). */
export interface Caller {
  /** Display name recorded in history, comments and links. */
  readonly name: string;
  /** Team member making the request, when known. */
  readonly memberId: string | null;
  /** Whether they may edit or delete other people's comments. */
  readonly mayModerateComments: boolean;
  readonly admin: AdminAccess;
  /** The browser tab the request came from, if any. */
  readonly origin: string | undefined;
}
