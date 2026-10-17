import type { RecycleBinError } from '#domain/recycle-bin/deleted-work-item.ts';
import { toWorkItemId, type WorkItemIdError } from '#domain/work-items/ids.ts';
import { err, ok, type Result } from '#shared/result.ts';
import type { Caller } from '../caller.ts';
import type { Committed } from '../ports.ts';
import type { WorkItemDeps } from './deps.ts';
import { runChange } from '../session.ts';

export interface PurgeWorkItemInput {
  readonly caller: Caller;
  readonly id: number;
}

/** Delete an item from the recycle bin for good. */
export class PurgeWorkItem {
  readonly #deps: WorkItemDeps;

  constructor(deps: WorkItemDeps) {
    this.#deps = deps;
  }

  async execute(input: PurgeWorkItemInput): Promise<Result<Committed<void>, RecycleBinError | WorkItemIdError>> {
    const id = toWorkItemId(input.id);
    if (!id.ok) return id;
    return runChange(this.#deps, input.caller, async (session) => {
      const entry = await this.#deps.recycleBin.findById(id.value);
      if (!entry) return err({ code: 'DELETED_WORK_ITEM_NOT_FOUND', id: input.id });
      entry.purge(session.now);
      await this.#deps.recycleBin.remove(id.value);
      session.record(entry);
      return ok(undefined);
    });
  }
}
