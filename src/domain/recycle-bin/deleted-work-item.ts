import type { RecycledItem, WorkItem, WorkItemLink } from '../types.ts';
import { Link } from '../links/link.ts';
import type { WorkItemId } from '../work-items/ids.ts';
import { WorkItemAggregate, cloneWorkItem, type ChangeContext, type SurvivingReferences } from '../work-items/work-item.ts';

export type RecycleBinError = { readonly code: 'DELETED_WORK_ITEM_NOT_FOUND'; readonly id: number };

export type RecycleBinEvent =
  | { readonly type: 'WorkItemDeleted'; readonly workItemId: number; readonly occurredAt: Date }
  | { readonly type: 'WorkItemPurged'; readonly workItemId: number; readonly occurredAt: Date };

/** References a deleted item had, which decide what comes back when it's restored. */
export interface DeletedItemReferences {
  readonly parentId: WorkItemId | null;
  readonly iterationId: string | null;
  readonly assignedTo: string | null;
  /** Items at the other end of the links deleted with it. */
  readonly linkedItemIds: readonly WorkItemId[];
}

export interface RestoreInput extends SurvivingReferences {
  /** Work items that exist now (the restored item counts). Links come back only if both ends exist. */
  readonly existingItemIds: ReadonlySet<number>;
  readonly context: ChangeContext;
}

/** A deleted work item in the recycle bin, kept with the links it had so both can be restored. */
export class DeletedWorkItem {
  readonly #item: WorkItem;
  readonly #links: readonly WorkItemLink[];
  readonly #deletedAt: string;
  readonly #deletedBy: string;
  #events: RecycleBinEvent[] = [];

  private constructor(item: WorkItem, links: readonly WorkItemLink[], deletedAt: string, deletedBy: string) {
    this.#item = item;
    this.#links = links;
    this.#deletedAt = deletedAt;
    this.#deletedBy = deletedBy;
  }

  static of(input: { readonly item: WorkItemAggregate; readonly links: readonly Link[]; readonly now: Date; readonly actor: string }): DeletedWorkItem {
    const deleted = new DeletedWorkItem(
      input.item.toSnapshot(),
      input.links.map((l) => l.toSnapshot()),
      input.now.toISOString(),
      input.actor,
    );
    deleted.#events.push({ type: 'WorkItemDeleted', workItemId: input.item.id, occurredAt: input.now });
    return deleted;
  }

  static reconstitute(snapshot: RecycledItem): DeletedWorkItem {
    // Validates the stored item; throws if it is corrupt.
    const item = WorkItemAggregate.reconstitute(snapshot.item).toSnapshot();
    return new DeletedWorkItem(item, snapshot.links.map((l) => ({ ...l })), snapshot.deletedAt, snapshot.deletedBy);
  }

  get id(): WorkItemId {
    return this.#item.id as WorkItemId;
  }

  get references(): DeletedItemReferences {
    const linked = this.#links.map((l) => (l.sourceId === this.#item.id ? l.targetId : l.sourceId) as WorkItemId);
    return {
      parentId: this.#item.parentId as WorkItemId | null,
      iterationId: this.#item.iterationId,
      assignedTo: this.#item.assignedTo,
      linkedItemIds: [...new Set(linked)],
    };
  }

  /** The item back as a live work item, with the links whose other end still exists. */
  restore(input: RestoreInput): { readonly item: WorkItemAggregate; readonly links: readonly Link[] } {
    const item = WorkItemAggregate.reconstitute(this.#item);
    item.restore(input, input.context);
    const links = this.#links
      .filter((l) => input.existingItemIds.has(l.sourceId) && input.existingItemIds.has(l.targetId))
      .map((l) => Link.reconstitute(l));
    return { item, links };
  }

  purge(now: Date): void {
    this.#events.push({ type: 'WorkItemPurged', workItemId: this.#item.id, occurredAt: now });
  }

  pullEvents(): readonly RecycleBinEvent[] {
    const events = this.#events;
    this.#events = [];
    return events;
  }

  toSnapshot(): RecycledItem {
    return { item: cloneWorkItem(this.#item), links: this.#links.map((l) => ({ ...l })), deletedAt: this.#deletedAt, deletedBy: this.#deletedBy };
  }
}
