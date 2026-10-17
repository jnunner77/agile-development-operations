import type { WorkItemError } from '#domain/work-items/errors.ts';
import type { Result } from '#shared/result.ts';
import type { Caller } from '../caller.ts';
import type { Committed } from '../ports.ts';
import type { WorkItemDeps } from './deps.ts';
import { findItem, removeItem } from './helpers.ts';
import { runChange } from './session.ts';

export interface DeleteWorkItemInput {
  readonly caller: Caller;
  readonly id: number;
}

/** Move an item to the recycle bin. */
export class DeleteWorkItem {
  readonly #deps: WorkItemDeps;

  constructor(deps: WorkItemDeps) {
    this.#deps = deps;
  }

  async execute(input: DeleteWorkItemInput): Promise<Result<Committed<void>, WorkItemError>> {
    return runChange(this.#deps, input.caller, async (session) => {
      const item = await findItem(this.#deps, input.id);
      if (!item.ok) return item;
      return removeItem(this.#deps, session, item.value);
    });
  }
}
