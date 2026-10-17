import type { SprintId } from '#domain/sprints/sprint.ts';
import type { MemberId } from '#domain/team/member.ts';
import type { WorkItemId } from '#domain/work-items/ids.ts';
import type { RankEntry, WorkItemRepository } from '#domain/work-items/repository.ts';
import { WorkItemAggregate } from '#domain/work-items/work-item.ts';
import type { WorkItem } from '#domain/types.ts';
import type { CurrentTransaction } from './unit-of-work.ts';
import type { Tx } from './store.ts';

/** Work items in the JSON store, read from and written to the running unit of work. */
export class JsonWorkItemRepository implements WorkItemRepository {
  readonly #tx: CurrentTransaction;
  readonly #indices = new WeakMap<Tx, Map<number, number>>();

  constructor(tx: CurrentTransaction) {
    this.#tx = tx;
  }

  async nextId(): Promise<WorkItemId> {
    const { db } = this.#tx.current();
    return db.nextWorkItemId++ as WorkItemId;
  }

  async findById(id: WorkItemId): Promise<WorkItemAggregate | undefined> {
    const row = this.#tx.current().db.workItems.find((w) => w.id === id);
    return row ? WorkItemAggregate.reconstitute(row) : undefined;
  }

  async findAll(): Promise<WorkItemAggregate[]> {
    return this.#tx.current().db.workItems.map((w) => WorkItemAggregate.reconstitute(w));
  }

  async findChildren(parentId: WorkItemId): Promise<WorkItemAggregate[]> {
    return this.#tx
      .current()
      .db.workItems.filter((w) => w.parentId === parentId)
      .map((w) => WorkItemAggregate.reconstitute(w));
  }

  async findInSprint(sprintId: SprintId): Promise<WorkItemAggregate[]> {
    return this.#where((w) => w.iterationId === sprintId);
  }

  async findAssignedTo(memberId: MemberId): Promise<WorkItemAggregate[]> {
    return this.#where((w) => w.assignedTo === memberId);
  }

  #where(match: (row: WorkItem) => boolean): WorkItemAggregate[] {
    return this.#tx.current().db.workItems.filter(match).map((w) => WorkItemAggregate.reconstitute(w));
  }

  async ranks(): Promise<RankEntry[]> {
    return this.#tx.current().db.workItems.map((w) => ({ id: w.id as WorkItemId, stackRank: w.stackRank }));
  }

  async save(item: WorkItemAggregate): Promise<void> {
    const tx = this.#tx.current();
    const row = item.toSnapshot();
    const index = this.#indexFor(tx);
    const idx = index.get(row.id);
    if (idx !== undefined) tx.db.workItems[idx] = row;
    else {
      index.set(row.id, tx.db.workItems.length);
      tx.db.workItems.push(row);
    }
    tx.touchItem(row.id);
  }

  async delete(id: WorkItemId): Promise<void> {
    const tx = this.#tx.current();
    const index = this.#indexFor(tx);
    const idx = index.get(id);
    if (idx !== undefined) {
      tx.db.workItems.splice(idx, 1);
      index.delete(id);
      for (let i = idx; i < tx.db.workItems.length; i += 1) {
        index.set(tx.db.workItems[i]!.id, i);
      }
    }
    tx.deletedItems.add(id);
  }

  #indexFor(tx: Tx): Map<number, number> {
    let index = this.#indices.get(tx);
    if (!index) {
      index = new Map(tx.db.workItems.map((row, position) => [row.id, position]));
      this.#indices.set(tx, index);
    }
    return index;
  }
}
