import type { ChangeFeed, ChangeListener } from '#application/ports.ts';
import type { Delta } from '#application/contracts/database.ts';

/** Changes in memory, for tests: `emit` stands for a commit. */
export class MemoryChangeFeed implements ChangeFeed {
  readonly #listeners = new Set<ChangeListener>();

  subscribe(listener: ChangeListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  emit(delta: Delta, origin?: string): void {
    for (const listener of this.#listeners) listener(delta, origin);
  }

  get listening(): number {
    return this.#listeners.size;
  }
}
