import { SprintChanges, type SprintError, type SprintInput } from '#domain/sprints/sprint.ts';
import type { Sprint as SprintData } from '#domain/types.ts';
import { ok, type Result } from '#shared/result.ts';
import type { Caller } from '../caller.ts';
import type { Committed } from '../ports.ts';
import { runChange } from '../session.ts';
import { findSprint, type SprintDeps } from './deps.ts';

export interface UpdateSprintInput extends SprintInput {
  readonly caller: Caller;
  readonly id: string;
}

export class UpdateSprint {
  readonly #deps: SprintDeps;

  constructor(deps: SprintDeps) {
    this.#deps = deps;
  }

  async execute(input: UpdateSprintInput): Promise<Result<Committed<SprintData>, SprintError>> {
    const changes = SprintChanges.validate(input);
    if (!changes.ok) return changes;
    return runChange(this.#deps, input.caller, async (session) => {
      const sprint = await findSprint(this.#deps, input.id);
      if (!sprint.ok) return sprint;
      const updated = sprint.value.update(changes.value, await this.#deps.sprints.findAll(), session.now);
      if (!updated.ok) return updated;
      await this.#deps.sprints.save(sprint.value);
      session.record(sprint.value);
      return ok(sprint.value.toSnapshot());
    });
  }
}
