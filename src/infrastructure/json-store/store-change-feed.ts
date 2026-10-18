import type { ChangeFeed, ChangeListener } from '#application/ports.ts';
import type { Store } from './store.ts';

/** The JSON store's committed changes. */
export class StoreChangeFeed implements ChangeFeed {
  readonly #store: Store;

  constructor(store: Store) {
    this.#store = store;
  }

  subscribe(listener: ChangeListener): () => void {
    const unsubscribe = this.#store.subscribe(listener);
    return () => {
      unsubscribe();
    };
  }
}
