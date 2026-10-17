import type { Member, MemberError } from '#domain/team/member.ts';
import type { WorkItemError } from '#domain/work-items/errors.ts';
import { err, ok, type Result } from '#shared/result.ts';
import type { AccessError } from '../access.ts';
import type { AppDeps } from '../deps.ts';

export type TeamDeps = Pick<
  AppDeps,
  'items' | 'sprints' | 'capacities' | 'members' | 'safeguard' | 'clock' | 'ids' | 'events' | 'unitOfWork'
>;

/** With sign-in on, a change may not leave the team without an administrator who can sign in. */
export type LastAdminError = { readonly code: 'LAST_ADMIN' };

/** Every error a team use case can return. */
export type TeamError = MemberError | AccessError | LastAdminError | WorkItemError;

/** Refuse a change that would leave no administrator who can sign in. */
export async function checkAdminRemains(deps: Pick<AppDeps, 'safeguard'>, team: readonly Member[]): Promise<Result<void, LastAdminError>> {
  const keeps = await deps.safeguard.keepsUsableAdmin(team.map((m) => m.toSnapshot()));
  return keeps ? ok(undefined) : err({ code: 'LAST_ADMIN' });
}
