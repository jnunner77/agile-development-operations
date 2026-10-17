import { AsyncLocalStorage } from 'node:async_hooks';
import type { ChangeMeta, Committed, UnitOfWork } from '#application/ports.ts';
import type { Result } from '#shared/result.ts';
import type { Store, Tx } from './store.ts';

/** Gives repositories the transaction of the unit of work they are running in. */
export interface CurrentTransaction {
  current(): Tx;
}

/**
 * A unit of work over the JSON store: the work runs against a working copy of the database,
 * which is saved and broadcast to browsers as one change only if the work succeeds.
 */
export class StoreUnitOfWork implements UnitOfWork, CurrentTransaction {
  readonly #store: Store;
  readonly #context = new AsyncLocalStorage<Tx>();

  constructor(store: Store) {
    this.#store = store;
  }

  run<T, E>(meta: ChangeMeta, work: () => Promise<Result<T, E>>): Promise<Result<Committed<T>, E>> {
    // Waiting for our own transaction to finish would never end.
    if (this.#context.getStore()) throw new Error('A unit of work is already running here; they cannot be nested');
    return this.#store.transactAsync(meta.actor, meta.origin, (tx) => this.#context.run(tx, work));
  }

  current(): Tx {
    const tx = this.#context.getStore();
    if (!tx) throw new Error('A repository was used outside a unit of work');
    return tx;
  }
}
