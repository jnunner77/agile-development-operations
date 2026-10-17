import type { WorkItemError } from '#domain/work-items/errors.ts';
import type { Result } from '#shared/result.ts';
import type { Caller } from '../caller.ts';
import type { Committed } from '../ports.ts';
import type { WorkItemDeps } from './deps.ts';
import { findItem, save } from './helpers.ts';
import { runChange } from '../session.ts';

export interface RemoveDevLinkInput {
  readonly caller: Caller;
  readonly workItemId: number;
  readonly linkId: string;
}

/** Remove a branch, commit or pull request link (it comes back if GitHub reports it again). */
export class RemoveDevLink {
  readonly #deps: WorkItemDeps;

  constructor(deps: WorkItemDeps) {
    this.#deps = deps;
  }

  async execute(input: RemoveDevLinkInput): Promise<Result<Committed<void>, WorkItemError>> {
    return runChange(this.#deps, input.caller, async (session) => {
      const item = await findItem(this.#deps, input.workItemId);
      if (!item.ok) return item;
      const removed = item.value.removeDevLink(input.linkId, session.context());
      if (removed.ok) await save(this.#deps, session, item.value);
      return removed;
    });
  }
}
