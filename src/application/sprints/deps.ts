import type { CapacityError } from '#domain/sprints/capacity-plan.ts';
import type { SprintError } from '#domain/sprints/sprint.ts';
import type { MemberError } from '#domain/team/member.ts';
import type { WorkItemError } from '#domain/work-items/errors.ts';
import type { AppDeps } from '../deps.ts';

export type SprintDeps = Pick<AppDeps, 'items' | 'sprints' | 'capacities' | 'members' | 'clock' | 'ids' | 'events' | 'unitOfWork'>;

/** Every error a sprint or capacity use case can return. */
export type SprintsError = SprintError | CapacityError | MemberError | WorkItemError;
