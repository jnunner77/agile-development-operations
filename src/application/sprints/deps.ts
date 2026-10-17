import type { CapacityError } from '#domain/sprints/capacity-plan.ts';
import { toSprintId, type Sprint, type SprintError } from '#domain/sprints/sprint.ts';
import type { MemberError } from '#domain/team/member.ts';
import type { WorkItemError } from '#domain/work-items/errors.ts';
import { err, type Result } from '#shared/result.ts';
import type { AppDeps } from '../deps.ts';

export type SprintDeps = Pick<AppDeps, 'items' | 'sprints' | 'capacities' | 'members' | 'clock' | 'ids' | 'events' | 'unitOfWork'>;

/** Every error a sprint or capacity use case can return. */
export type SprintsError = SprintError | CapacityError | MemberError | WorkItemError;

export async function findSprint(deps: Pick<AppDeps, 'sprints'>, rawId: string): Promise<Result<Sprint, SprintError>> {
  const id = toSprintId(rawId);
  if (!id.ok) return id;
  const sprint = await deps.sprints.findById(id.value);
  return sprint ? { ok: true, value: sprint } : err({ code: 'SPRINT_NOT_FOUND', id: rawId });
}
