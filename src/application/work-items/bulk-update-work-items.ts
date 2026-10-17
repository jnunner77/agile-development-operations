import { bulkChangesFor } from '#domain/work-items/bulk.ts';
import type { WorkItemError } from '#domain/work-items/errors.ts';
import { FieldChanges, type FieldInput } from '#domain/work-items/fields.ts';
import { retag, validateTags, validateTagsToRemove } from '#domain/work-items/tags.ts';
import { err, ok, type Result } from '#shared/result.ts';
import type { Caller } from '../caller.ts';
import type { Committed } from '../ports.ts';
import type { WorkItemDeps } from './deps.ts';
import { editItem, findItem } from './helpers.ts';
import { runChange } from './session.ts';

export interface BulkUpdateWorkItemsInput {
  readonly caller: Caller;
  readonly ids: readonly number[];
  readonly changes: FieldInput;
  readonly addTags?: readonly string[] | undefined;
  readonly removeTags?: readonly string[] | undefined;
}

/** Apply one set of changes to several items. All or nothing: any refusal changes no item. */
export class BulkUpdateWorkItems {
  readonly #deps: WorkItemDeps;

  constructor(deps: WorkItemDeps) {
    this.#deps = deps;
  }

  async execute(input: BulkUpdateWorkItemsInput): Promise<Result<Committed<void>, WorkItemError>> {
    const changes = FieldChanges.validate(input.changes);
    if (!changes.ok) return changes;
    const add = validateTags(input.addTags ?? []);
    if (!add.ok) return add;
    const remove = validateTagsToRemove(input.removeTags ?? []);
    if (!remove.ok) return remove;
    const retagging = add.value.length > 0 || remove.value.length > 0;

    return runChange(this.#deps, input.caller, async (session) => {
      for (const rawId of input.ids) {
        const item = await findItem(this.#deps, rawId);
        if (!item.ok) return item;
        const newParent = changes.value.parentId;
        let parentType;
        if (newParent != null) {
          const parent = await findItem(this.#deps, newParent);
          if (!parent.ok) return parent;
          parentType = parent.value.type;
        }
        let itemChanges = bulkChangesFor(item.value, changes.value, parentType);
        if (retagging) {
          const tags = retag(item.value.tags, add.value, remove.value);
          if (!tags.ok) return err({ code: 'ITEM_TAG_LIMIT', id: rawId, max: tags.error.max });
          const withTags = FieldChanges.validate({ ...itemChanges.values, tags: tags.value });
          if (!withTags.ok) return withTags;
          itemChanges = withTags.value;
        }
        const edited = await editItem(this.#deps, session, item.value, itemChanges, { cascade: true });
        if (!edited.ok) return edited;
      }
      return ok(undefined);
    });
  }
}
