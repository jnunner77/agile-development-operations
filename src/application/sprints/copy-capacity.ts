import { CapacityPlan } from '#domain/sprints/capacity-plan.ts';
import type { SprintError } from '#domain/sprints/sprint.ts';
import type { SprintCapacity } from '#domain/types.ts';
import { ok, type Result } from '#shared/result.ts';
import type { Caller } from '../caller.ts';
import type { Committed } from '../ports.ts';
import { runChange } from '../session.ts';
import { findSprint, type SprintDeps } from './deps.ts';

export interface CopyCapacityInput {
  readonly caller: Caller;
  readonly sprintId: string;
  readonly fromSprintId: string;
}

/** Take another sprint's people and activities, keeping this sprint's own days off. */
export class CopyCapacity {
  readonly #deps: SprintDeps;

  constructor(deps: SprintDeps) {
    this.#deps = deps;
  }

  async execute(input: CopyCapacityInput): Promise<Result<Committed<SprintCapacity>, SprintError>> {
    return runChange(this.#deps, input.caller, async (session) => {
      const { capacities } = this.#deps;
      const from = await findSprint(this.#deps, input.fromSprintId);
      if (!from.ok) return from;
      const to = await findSprint(this.#deps, input.sprintId);
      if (!to.ok) return to;
      const source = (await capacities.findBySprint(from.value.id)) ?? CapacityPlan.empty(from.value.id);
      const plan = (await capacities.findBySprint(to.value.id)) ?? CapacityPlan.empty(to.value.id);
      plan.copyFrom(source, session.now);
      await capacities.save(plan);
      session.record(plan);
      return ok(plan.toSnapshot());
    });
  }
}
