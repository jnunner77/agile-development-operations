import type { Member } from '#domain/types.ts';
import { adminAccessOf, mayModerateCommentsOf } from './access.ts';
import type { Identity } from './sign-in/identity.ts';

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

export interface CallerInput {
  readonly identity: Identity;
  /**
   * Who the browser says it is acting as (the X-User header, decoded: a member id or a name).
   * The sign-in gate has already replaced it with the signed-in member or token's member, or
   * dropped it, so it is only taken as sent while sign-in is off.
   */
  readonly actingAs: string | null;
  readonly team: readonly Member[];
  /** The browser tab the request came from, if any. */
  readonly origin: string | undefined;
}

/**
 * The caller for a request: named after the member it acts as (or what the browser sent, cut to
 * 128 characters), with the rights its identity gives. A name only one member has counts as them.
 */
export function callerFor(input: CallerInput): Caller {
  const { identity, actingAs, team } = input;
  const named = actingAs === null ? undefined : team.find((m) => m.id === actingAs);
  const name = actingAs === null ? 'Anonymous' : (named?.name ?? actingAs.slice(0, 128));
  let memberId: string | null = identity.member?.id ?? null;
  if (!memberId && actingAs !== null) {
    if (named) memberId = named.id;
    else {
      const sameName = team.filter((m) => m.name === actingAs);
      memberId = sameName.length === 1 ? (sameName[0]?.id ?? null) : null;
    }
  }
  return {
    name,
    memberId,
    mayModerateComments: mayModerateCommentsOf(identity),
    admin: adminAccessOf(identity),
    origin: input.origin,
  };
}
