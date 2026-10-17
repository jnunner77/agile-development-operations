import { CapacityChanges, CapacityPlan, type CapacityInput } from '#domain/sprints/capacity-plan.ts';
import type { SprintCapacity } from '#domain/types.ts';
import { err, ok, type Result } from '#shared/result.ts';
import type { Caller } from '../caller.ts';
import type { Committed } from '../ports.ts';
import { runChange } from '../session.ts';
import { memberExists } from '../work-items/helpers.ts';
import { findSprint, type SprintDeps, type SprintsError } from './deps.ts';

export interface SetCapacityInput extends CapacityInput {
  readonly caller: Caller;
  readonly sprintId: string;
}

/** Replace a sprint's capacity plan. Everyone in it must be on the team. */
export class SetCapacity {
  readonly #deps: SprintDeps;

  constructor(deps: SprintDeps) {
    this.#deps = deps;
  }

  async execute(input: SetCapacityInput): Promise<Result<Committed<SprintCapacity>, SprintsError>> {
    const changes = CapacityChanges.validate(input);
    if (!changes.ok) return changes;
    return runChange<SprintCapacity, SprintsError>(this.#deps, input.caller, async (session) => {
      const sprint = await findSprint(this.#deps, input.sprintId);
      if (!sprint.ok) return sprint;
      for (const memberId of changes.value.memberIds) {
        if (!(await memberExists(this.#deps, memberId))) return err({ code: 'MEMBER_NOT_FOUND', id: memberId });
      }
      const plan = (await this.#deps.capacities.findBySprint(sprint.value.id)) ?? CapacityPlan.empty(sprint.value.id);
      plan.replace(changes.value, session.now);
      await this.#deps.capacities.save(plan);
      session.record(plan);
      return ok(plan.toSnapshot());
    });
  }
}
