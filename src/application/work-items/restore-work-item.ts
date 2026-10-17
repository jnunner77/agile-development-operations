import type { RecycleBinError } from '#domain/recycle-bin/deleted-work-item.ts';
import { toWorkItemId } from '#domain/work-items/ids.ts';
import type { WorkItemIdError } from '#domain/work-items/ids.ts';
import type { WorkItem } from '#domain/types.ts';
import { err, ok, type Result } from '#shared/result.ts';
import type { Caller } from '../caller.ts';
import type { Committed } from '../ports.ts';
import type { WorkItemDeps } from './deps.ts';
import { memberExists, sprintExists } from '../lookups.ts';
import { save } from './helpers.ts';
import { runChange } from '../session.ts';

export interface RestoreWorkItemInput {
  readonly caller: Caller;
  readonly id: number;
}

/** Bring an item back from the recycle bin, with the links whose other end still exists. */
export class RestoreWorkItem {
  readonly #deps: WorkItemDeps;

  constructor(deps: WorkItemDeps) {
    this.#deps = deps;
  }

  async execute(input: RestoreWorkItemInput): Promise<Result<Committed<WorkItem>, RecycleBinError | WorkItemIdError>> {
    const id = toWorkItemId(input.id);
    if (!id.ok) return id;
    return runChange(this.#deps, input.caller, async (session) => {
      const { items, links, recycleBin } = this.#deps;
      const entry = await recycleBin.findById(id.value);
      if (!entry) return err({ code: 'DELETED_WORK_ITEM_NOT_FOUND', id: input.id });
      await recycleBin.remove(id.value);

      const refs = entry.references;
      const existingItemIds = new Set<number>([entry.id]);
      for (const linked of refs.linkedItemIds) if (await items.findById(linked)) existingItemIds.add(linked);
      const restored = entry.restore({
        parent: refs.parentId != null && !!(await items.findById(refs.parentId)),
        sprint: !!refs.iterationId && (await sprintExists(this.#deps, refs.iterationId)),
        member: !!refs.assignedTo && (await memberExists(this.#deps, refs.assignedTo)),
        existingItemIds,
        context: session.context(),
      });
      await save(this.#deps, session, restored.item);
      for (const link of restored.links) await links.save(link);
      return ok(restored.item.toSnapshot());
    });
  }
}
