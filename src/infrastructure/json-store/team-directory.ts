import type { TeamDirectory } from '#application/ports.ts';
import type { Member } from '#domain/types.ts';
import type { Store } from './store.ts';

/** The team as last committed to the store, read without a unit of work. */
export class StoreTeamDirectory implements TeamDirectory {
  readonly #store: Store;

  constructor(store: Store) {
    this.#store = store;
  }

  async all(): Promise<Member[]> {
    return this.#store.db.members.map((m) => ({ ...m }));
  }

  async findById(id: string): Promise<Member | undefined> {
    const member = this.#store.db.members.find((m) => m.id === id);
    return member ? { ...member } : undefined;
  }
}
