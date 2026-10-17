import { FieldChanges, type FieldInput } from '#domain/work-items/fields.ts';
import type { WorkItemError } from '#domain/work-items/errors.ts';
import type { WorkItem } from '#domain/types.ts';
import { ok, type Result } from '#shared/result.ts';
import type { Caller } from '../caller.ts';
import type { Committed } from '../ports.ts';
import type { WorkItemDeps } from './deps.ts';
import { editItem, findItem } from './helpers.ts';
import { runChange } from '../session.ts';

export interface UpdateWorkItemInput {
  readonly caller: Caller;
  readonly id: number;
  readonly changes: FieldInput;
}

/** Edit fields from the work item form. Child tasks don't follow a sprint change made here. */
export class UpdateWorkItem {
  readonly #deps: WorkItemDeps;

  constructor(deps: WorkItemDeps) {
    this.#deps = deps;
  }

  async execute(input: UpdateWorkItemInput): Promise<Result<Committed<WorkItem>, WorkItemError>> {
    const changes = FieldChanges.validate(input.changes);
    if (!changes.ok) return changes;
    return runChange(this.#deps, input.caller, async (session) => {
      const item = await findItem(this.#deps, input.id);
      if (!item.ok) return item;
      const edited = await editItem(this.#deps, session, item.value, changes.value, { cascade: false });
      return edited.ok ? ok(item.value.toSnapshot()) : edited;
    });
  }
}
