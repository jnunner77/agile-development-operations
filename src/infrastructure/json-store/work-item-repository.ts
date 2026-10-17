import type { WorkItemId } from '#domain/work-items/ids.ts';
import type { RankEntry, WorkItemRepository } from '#domain/work-items/repository.ts';
import { WorkItemAggregate } from '#domain/work-items/work-item.ts';
import type { CurrentTransaction } from './unit-of-work.ts';

/** Work items in the JSON store, read from and written to the running unit of work. */
export class JsonWorkItemRepository implements WorkItemRepository {
  readonly #tx: CurrentTransaction;

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

  async ranks(): Promise<RankEntry[]> {
    return this.#tx.current().db.workItems.map((w) => ({ id: w.id as WorkItemId, stackRank: w.stackRank }));
  }

  async save(item: WorkItemAggregate): Promise<void> {
    const tx = this.#tx.current();
    const row = item.toSnapshot();
    const idx = tx.db.workItems.findIndex((w) => w.id === row.id);
    if (idx >= 0) tx.db.workItems[idx] = row;
    else tx.db.workItems.push(row);
    tx.touchItem(row.id);
  }

  async delete(id: WorkItemId): Promise<void> {
    const tx = this.#tx.current();
    tx.db.workItems = tx.db.workItems.filter((w) => w.id !== id);
    tx.deletedItems.add(id);
  }
}
