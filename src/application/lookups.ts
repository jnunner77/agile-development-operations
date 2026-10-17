import { toSprintId, type Sprint, type SprintError } from '#domain/sprints/sprint.ts';
import { toMemberId, type Member, type MemberError } from '#domain/team/member.ts';
import { err, ok, type Result } from '#shared/result.ts';
import type { AppDeps } from './deps.ts';

// Finding sprints and members by the ids callers send, shared by every module.

export async function findSprint(deps: Pick<AppDeps, 'sprints'>, rawId: string): Promise<Result<Sprint, SprintError>> {
  const id = toSprintId(rawId);
  if (!id.ok) return id;
  const sprint = await deps.sprints.findById(id.value);
  return sprint ? ok(sprint) : err({ code: 'SPRINT_NOT_FOUND', id: rawId });
}

export async function findMember(deps: Pick<AppDeps, 'members'>, rawId: string): Promise<Result<Member, MemberError>> {
  const id = toMemberId(rawId);
  if (!id.ok) return id;
  const member = await deps.members.findById(id.value);
  return member ? ok(member) : err({ code: 'MEMBER_NOT_FOUND', id: rawId });
}

export const sprintExists = async (deps: Pick<AppDeps, 'sprints'>, rawId: string): Promise<boolean> => (await findSprint(deps, rawId)).ok;
export const memberExists = async (deps: Pick<AppDeps, 'members'>, rawId: string): Promise<boolean> => (await findMember(deps, rawId)).ok;
