import { FieldChanges, type FieldInput } from '#domain/work-items/fields.ts';
import type { WorkItemError } from '#domain/work-items/errors.ts';
import { toWorkItemId, type WorkItemId } from '#domain/work-items/ids.ts';
import { needsRenumbering, rankBetween, renumbered } from '#domain/work-items/ranking.ts';
import type { WorkItem } from '#domain/types.ts';
import { ok, type Result } from '#shared/result.ts';
import type { Caller } from '../caller.ts';
import type { Committed } from '../ports.ts';
import type { WorkItemDeps } from './deps.ts';
import { editItem, findItem, save } from './helpers.ts';
import { runChange } from './session.ts';

export interface MoveWorkItemInput {
  readonly caller: Caller;
  readonly id: number;
  readonly iterationId?: string | null | undefined;
  readonly parentId?: number | null | undefined;
  readonly state?: string | undefined;
  readonly assignedTo?: string | null | undefined;
  /** Place the item right after this one. */
  readonly afterId?: number | null | undefined;
  /** Place the item right before this one. */
  readonly beforeId?: number | null | undefined;
}

/** Drag and drop: reorder, and optionally change sprint, parent, state or assignee, in one step. */
export class MoveWorkItem {
  readonly #deps: WorkItemDeps;

  constructor(deps: WorkItemDeps) {
    this.#deps = deps;
  }

  async execute(input: MoveWorkItemInput): Promise<Result<Committed<WorkItem>, WorkItemError>> {
    const fields: { -readonly [K in keyof FieldInput]: FieldInput[K] } = {};
    if (input.iterationId !== undefined) fields.iterationId = input.iterationId;
    if (input.parentId !== undefined) fields.parentId = input.parentId;
    if (input.state !== undefined) fields.state = input.state;
    if (input.assignedTo !== undefined) fields.assignedTo = input.assignedTo;
    const changes = FieldChanges.validate(fields);
    if (!changes.ok) return changes;
    const after = optionalId(input.afterId);
    if (!after.ok) return after;
    const before = optionalId(input.beforeId);
    if (!before.ok) return before;

    return runChange(this.#deps, input.caller, async (session) => {
      const found = await findItem(this.#deps, input.id);
      if (!found.ok) return found;
      const item = found.value;
      const edited = await editItem(this.#deps, session, item, changes.value, { cascade: true });
      if (!edited.ok) return edited;
      if (after.value === null && before.value === null) return ok(item.toSnapshot());

      const ranks = await this.#deps.items.ranks();
      const rank = rankBetween(ranks, item.id, after.value, before.value, item.stackRank);
      if (!rank.ok) return rank;
      if (item.moveToRank(rank.value)) await save(this.#deps, session, item);
      const updated = ranks.map((r) => (r.id === item.id ? { id: r.id, stackRank: rank.value } : r));
      if (needsRenumbering(updated)) {
        for (const [id, newRank] of renumbered(updated)) {
          const other = id === item.id ? item : await this.#deps.items.findById(id);
          if (other?.moveToRank(newRank)) await save(this.#deps, session, other);
        }
      }
      return ok(item.toSnapshot());
    });
  }
}

function optionalId(value: number | null | undefined): Result<WorkItemId | null, WorkItemError> {
  return value == null ? ok(null) : toWorkItemId(value);
}
