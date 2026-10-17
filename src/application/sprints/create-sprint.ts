import { CapacityPlan } from '#domain/sprints/capacity-plan.ts';
import { Sprint, SprintChanges, previousSprint, type SprintError, type SprintId, type SprintInput } from '#domain/sprints/sprint.ts';
import type { Sprint as SprintData } from '#domain/types.ts';
import { ok, type Result } from '#shared/result.ts';
import type { Caller } from '../caller.ts';
import type { Committed } from '../ports.ts';
import { runChange } from '../session.ts';
import type { SprintDeps } from './deps.ts';

export interface CreateSprintInput extends SprintInput {
  readonly caller: Caller;
}

/** Add a sprint. Its capacity plan starts from the previous sprint's people and activities. */
export class CreateSprint {
  readonly #deps: SprintDeps;

  constructor(deps: SprintDeps) {
    this.#deps = deps;
  }

  async execute(input: CreateSprintInput): Promise<Result<Committed<SprintData>, SprintError>> {
    const changes = SprintChanges.validate(input);
    if (!changes.ok) return changes;
    return runChange(this.#deps, input.caller, async (session) => {
      const { sprints, capacities } = this.#deps;
      const existing = await sprints.findAll();
      const created = Sprint.create(changes.value, { id: session.newId() as SprintId, existing, now: session.now });
      if (!created.ok) return created;
      const sprint = created.value;
      await sprints.save(sprint);
      session.record(sprint);
      const previous = previousSprint(sprint, existing);
      const plan = CapacityPlan.carriedForward(sprint.id, previous ? await capacities.findBySprint(previous.id) : undefined);
      await capacities.save(plan);
      return ok(sprint.toSnapshot());
    });
  }
}
