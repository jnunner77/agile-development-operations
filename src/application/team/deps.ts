import type { Member, MemberError } from '#domain/team/member.ts';
import type { WorkItemError } from '#domain/work-items/errors.ts';
import { err, ok, type Result } from '#shared/result.ts';
import type { AccessError } from '../access.ts';
import type { AppDeps } from '../deps.ts';
import { signInState } from '../sign-in/deps.ts';
import { accountsByMember, hasUsableAdmin } from '#domain/sign-in/admins.ts';

export type TeamDeps = Pick<
  AppDeps,
  'items' | 'sprints' | 'capacities' | 'members' | 'accounts' | 'signInSettings' | 'signInForcedOff' | 'clock' | 'ids' | 'events' | 'unitOfWork'
>;

/** With sign-in on, a change may not leave the team without an administrator who can sign in. */
export type LastAdminError = { readonly code: 'LAST_ADMIN' };

/** Every error a team use case can return. */
export type TeamError = MemberError | AccessError | LastAdminError | WorkItemError;

/** With sign-in on, refuse a change that would leave no administrator who can sign in. */
export async function checkAdminRemains(
  deps: Pick<AppDeps, 'accounts' | 'signInSettings' | 'signInForcedOff'>,
  team: readonly Member[],
): Promise<Result<void, LastAdminError>> {
  const { enabled } = await signInState(deps);
  if (!enabled) return ok(undefined);
  const keeps = hasUsableAdmin(
    team.map((m) => m.toSnapshot()),
    accountsByMember(await deps.accounts.all()),
  );
  return keeps ? ok(undefined) : err({ code: 'LAST_ADMIN' });
}
