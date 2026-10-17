import { DeletedWorkItem } from '#domain/recycle-bin/deleted-work-item.ts';
import type { RecycleBinRepository } from '#domain/recycle-bin/repository.ts';
import type { WorkItemId } from '#domain/work-items/ids.ts';
import type { CurrentTransaction } from './unit-of-work.ts';

export class JsonRecycleBinRepository implements RecycleBinRepository {
  readonly #tx: CurrentTransaction;

  constructor(tx: CurrentTransaction) {
    this.#tx = tx;
  }

  async findById(id: WorkItemId): Promise<DeletedWorkItem | undefined> {
    const row = this.#tx.current().db.recycleBin.find((r) => r.item.id === id);
    return row ? DeletedWorkItem.reconstitute(row) : undefined;
  }

  async add(entry: DeletedWorkItem): Promise<void> {
    const tx = this.#tx.current();
    tx.db.recycleBin.unshift(entry.toSnapshot());
    tx.recycleBin = true;
  }

  async remove(id: WorkItemId): Promise<void> {
    const tx = this.#tx.current();
    tx.db.recycleBin = tx.db.recycleBin.filter((r) => r.item.id !== id);
    tx.recycleBin = true;
  }
}
