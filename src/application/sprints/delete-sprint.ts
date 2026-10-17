import { FieldChanges } from '#domain/work-items/fields.ts';
import { err, ok, type Result } from '#shared/result.ts';
import type { Caller } from '../caller.ts';
import type { Committed } from '../ports.ts';
import { runChange } from '../session.ts';
import { editItem } from '../work-items/helpers.ts';
import { type SprintDeps, type SprintsError } from './deps.ts';
import { findSprint } from '../lookups.ts';

export interface DeleteSprintInput {
  readonly caller: Caller;
  readonly id: string;
  /** Where the sprint's work goes: another sprint, or the backlog (null). */
  readonly moveTo: string | null;
}

/** Delete a sprint and its capacity plan, moving all of its work, open or closed, to `moveTo`. */
export class DeleteSprint {
  readonly #deps: SprintDeps;

  constructor(deps: SprintDeps) {
    this.#deps = deps;
  }

  async execute(input: DeleteSprintInput): Promise<Result<Committed<void>, SprintsError>> {
    const move = FieldChanges.validate({ iterationId: input.moveTo });
    if (!move.ok) return move;
    return runChange<void, SprintsError>(this.#deps, input.caller, async (session) => {
      const found = await findSprint(this.#deps, input.id);
      if (!found.ok) return found;
      const sprint = found.value;
      if (input.moveTo === sprint.id) return err({ code: 'SPRINT_MOVE_TO_SELF' });
      if (input.moveTo !== null) {
        const destination = await findSprint(this.#deps, input.moveTo);
        if (!destination.ok) return destination;
      }
      for (const item of await this.#deps.items.findInSprint(sprint.id)) {
        const moved = await editItem(this.#deps, session, item, move.value, { cascade: false, note: 'Sprint was deleted' });
        if (!moved.ok) return moved;
      }
      await this.#deps.capacities.delete(sprint.id);
      sprint.markDeleted(session.now);
      await this.#deps.sprints.delete(sprint.id);
      session.record(sprint);
      return ok(undefined);
    });
  }
}
