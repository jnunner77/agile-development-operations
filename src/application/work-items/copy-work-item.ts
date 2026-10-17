import { LinkDraft } from '#domain/links/link.ts';
import { copiedFields, copyTitle } from '#domain/work-items/copy.ts';
import { FieldChanges } from '#domain/work-items/fields.ts';
import { needsRenumbering, rankBetween, renumbered } from '#domain/work-items/ranking.ts';
import type { WorkItemAggregate } from '#domain/work-items/work-item.ts';
import type { WorkItem } from '#domain/types.ts';
import { err, ok, type Result } from '#shared/result.ts';
import type { Caller } from '../caller.ts';
import type { Committed } from '../ports.ts';
import type { WorkItemDeps, WorkItemsError } from './deps.ts';
import type { ChangeSession } from '../session.ts';
import { createItem, findItem, linkItems, save } from './helpers.ts';
import { runChange } from '../session.ts';

export interface CopyWorkItemInput {
  readonly caller: Caller;
  readonly id: number;
  readonly includeChildren: boolean;
}

/** Copy an item (and optionally its children) right after the original, linked to it. */
export class CopyWorkItem {
  readonly #deps: WorkItemDeps;

  constructor(deps: WorkItemDeps) {
    this.#deps = deps;
  }

  async execute(input: CopyWorkItemInput): Promise<Result<Committed<WorkItem>, WorkItemsError>> {
    return runChange(this.#deps, input.caller, async (session) => {
      const found = await findItem(this.#deps, input.id);
      if (!found.ok) return found;
      const source = found.value;
      const root = await this.#copyOne(session, source, copyTitle(source.title), source.parentId);
      if (!root.ok) return root;

      const draft = LinkDraft.of({ sourceId: root.value.id, targetId: source.id, type: 'Related', comment: 'Copied from' });
      if (!draft.ok) return draft;
      const linked = await linkItems(this.#deps, session, draft.value);
      if (!linked.ok) return linked;

      if (input.includeChildren) {
        for (const child of await this.#deps.items.findChildren(source.id)) {
          if (child.id === root.value.id) continue;
          const copied = await this.#copyOne(session, child, child.title, root.value.id);
          if (!copied.ok) return copied;
        }
      }
      const result = await this.#deps.items.findById(root.value.id);
      return result ? ok(result.toSnapshot()) : err({ code: 'WORK_ITEM_NOT_FOUND', id: root.value.id });
    });
  }

  async #copyOne(session: ChangeSession, from: WorkItemAggregate, title: string, parentId: number | null): Promise<Result<WorkItemAggregate, WorkItemsError>> {
    const fields = FieldChanges.validate(copiedFields(from, title, parentId));
    if (!fields.ok) return fields;
    const copy = await createItem(this.#deps, session, { type: from.type, fields: fields.value, position: 'bottom' });
    if (!copy.ok) return copy;
    const ranks = await this.#deps.items.ranks();
    const rank = rankBetween(ranks, copy.value.id, from.id, null, copy.value.stackRank);
    if (!rank.ok) return rank;
    if (copy.value.moveToRank(rank.value)) await save(this.#deps, session, copy.value);
    const updated = ranks.map((r) => (r.id === copy.value.id ? { id: r.id, stackRank: rank.value } : r));
    if (needsRenumbering(updated)) {
      for (const [id, newRank] of renumbered(updated)) {
        const item = id === copy.value.id ? copy.value : await this.#deps.items.findById(id);
        if (item?.moveToRank(newRank)) await save(this.#deps, session, item);
      }
    }
    return copy;
  }
}
