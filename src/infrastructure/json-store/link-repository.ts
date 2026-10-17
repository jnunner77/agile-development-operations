import { Link, type LinkId } from '#domain/links/link.ts';
import type { LinkRepository } from '#domain/links/repository.ts';
import type { WorkItemId } from '#domain/work-items/ids.ts';
import type { CurrentTransaction } from './unit-of-work.ts';

export class JsonLinkRepository implements LinkRepository {
  readonly #tx: CurrentTransaction;

  constructor(tx: CurrentTransaction) {
    this.#tx = tx;
  }

  async findById(id: LinkId): Promise<Link | undefined> {
    const row = this.#tx.current().db.links.find((l) => l.id === id);
    return row ? Link.reconstitute(row) : undefined;
  }

  async findByItem(itemId: WorkItemId): Promise<Link[]> {
    return this.#tx
      .current()
      .db.links.filter((l) => l.sourceId === itemId || l.targetId === itemId)
      .map((l) => Link.reconstitute(l));
  }

  async save(link: Link): Promise<void> {
    const tx = this.#tx.current();
    const row = link.toSnapshot();
    const idx = tx.db.links.findIndex((l) => l.id === row.id);
    if (idx >= 0) tx.db.links[idx] = row;
    else tx.db.links.push(row);
    tx.touchLink(row.id);
  }

  async delete(id: LinkId): Promise<void> {
    const tx = this.#tx.current();
    tx.db.links = tx.db.links.filter((l) => l.id !== id);
    tx.deletedLinks.add(id);
  }
}
