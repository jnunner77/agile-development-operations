import { DeletedWorkItem } from '#domain/recycle-bin/deleted-work-item.ts';
import type { RecycleBinRepository } from '#domain/recycle-bin/repository.ts';
import type { RecycledItem } from '#domain/types.ts';
import type { WorkItemId } from '#domain/work-items/ids.ts';
import type { Checkpointable } from './checkpoint.ts';

export class MemoryRecycleBinRepository implements RecycleBinRepository, Checkpointable {
  #rows: RecycledItem[] = [];

  async findById(id: WorkItemId): Promise<DeletedWorkItem | undefined> {
    const row = this.#rows.find((r) => r.item.id === id);
    return row ? DeletedWorkItem.reconstitute(structuredClone(row)) : undefined;
  }

  async add(entry: DeletedWorkItem): Promise<void> {
    this.#rows.unshift(structuredClone(entry.toSnapshot()));
  }

  async remove(id: WorkItemId): Promise<void> {
    this.#rows = this.#rows.filter((r) => r.item.id !== id);
  }

  rows(): RecycledItem[] {
    return structuredClone(this.#rows);
  }

  checkpoint(): () => void {
    const rows = structuredClone(this.#rows);
    return () => {
      this.#rows = rows;
    };
  }
}
