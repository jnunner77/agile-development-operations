import type { WorkItemError } from '#domain/work-items/errors.ts';
import { ok, type Result } from '#shared/result.ts';
import type { Caller } from '../caller.ts';
import type { Committed } from '../ports.ts';
import type { WorkItemDeps } from './deps.ts';
import { findItem, removeItem } from './helpers.ts';
import { runChange } from '../session.ts';

export interface DeleteWorkItemsInput {
  readonly caller: Caller;
  readonly ids: readonly number[];
}

/** Move several items to the recycle bin. Ids that are already gone are skipped. */
export class DeleteWorkItems {
  readonly #deps: WorkItemDeps;

  constructor(deps: WorkItemDeps) {
    this.#deps = deps;
  }

  async execute(input: DeleteWorkItemsInput): Promise<Result<Committed<void>, WorkItemError>> {
    return runChange(this.#deps, input.caller, async (session) => {
      for (const id of input.ids) {
        const item = await findItem(this.#deps, id);
        if (!item.ok) continue;
        const removed = await removeItem(this.#deps, session, item.value);
        if (!removed.ok) return removed;
      }
      return ok(undefined);
    });
  }
}
