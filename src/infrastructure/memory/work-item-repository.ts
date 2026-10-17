import type { WorkItemId } from '#domain/work-items/ids.ts';
import type { RankEntry, WorkItemRepository } from '#domain/work-items/repository.ts';
import { WorkItemAggregate } from '#domain/work-items/work-item.ts';
import type { WorkItem } from '#domain/types.ts';
import type { Checkpointable } from './checkpoint.ts';

/** Keeps snapshot copies, never live aggregates, so mapping and aliasing bugs show up in tests. */
export class MemoryWorkItemRepository implements WorkItemRepository, Checkpointable {
  #rows: WorkItem[] = [];
  #nextId = 1;

  constructor(rows: readonly WorkItem[] = []) {
    this.#rows = rows.map((r) => structuredClone(r));
    this.#nextId = rows.reduce((m, r) => Math.max(m, r.id), 0) + 1;
  }

  async nextId(): Promise<WorkItemId> {
    return this.#nextId++ as WorkItemId;
  }

  async findById(id: WorkItemId): Promise<WorkItemAggregate | undefined> {
    const row = this.#rows.find((w) => w.id === id);
    return row ? WorkItemAggregate.reconstitute(structuredClone(row)) : undefined;
  }

  async findAll(): Promise<WorkItemAggregate[]> {
    return this.#rows.map((w) => WorkItemAggregate.reconstitute(structuredClone(w)));
  }

  async findChildren(parentId: WorkItemId): Promise<WorkItemAggregate[]> {
    return this.#rows.filter((w) => w.parentId === parentId).map((w) => WorkItemAggregate.reconstitute(structuredClone(w)));
  }

  async ranks(): Promise<RankEntry[]> {
    return this.#rows.map((w) => ({ id: w.id as WorkItemId, stackRank: w.stackRank }));
  }

  async save(item: WorkItemAggregate): Promise<void> {
    const row = structuredClone(item.toSnapshot());
    const idx = this.#rows.findIndex((w) => w.id === row.id);
    if (idx >= 0) this.#rows[idx] = row;
    else this.#rows.push(row);
  }

  async delete(id: WorkItemId): Promise<void> {
    this.#rows = this.#rows.filter((w) => w.id !== id);
  }

  /** Stored rows, for assertions. */
  rows(): WorkItem[] {
    return structuredClone(this.#rows);
  }

  checkpoint(): () => void {
    const rows = structuredClone(this.#rows);
    const nextId = this.#nextId;
    return () => {
      this.#rows = rows;
      this.#nextId = nextId;
    };
  }
}
