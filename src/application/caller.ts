/** Who is asking, as established by the delivery layer (sign-in, API token or X-User header). */
export interface Caller {
  /** Display name recorded in history, comments and links. */
  readonly name: string;
  /** Team member making the request, when known. */
  readonly memberId: string | null;
  /** Whether they may edit or delete other people's comments. */
  readonly mayModerateComments: boolean;
  /** The browser tab the request came from, if any. */
  readonly origin: string | undefined;
}
