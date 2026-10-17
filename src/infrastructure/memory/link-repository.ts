import { Link, type LinkId } from '#domain/links/link.ts';
import type { LinkRepository } from '#domain/links/repository.ts';
import type { WorkItemLink } from '#domain/types.ts';
import type { WorkItemId } from '#domain/work-items/ids.ts';
import type { Checkpointable } from './checkpoint.ts';

export class MemoryLinkRepository implements LinkRepository, Checkpointable {
  #rows: WorkItemLink[] = [];

  async findById(id: LinkId): Promise<Link | undefined> {
    const row = this.#rows.find((l) => l.id === id);
    return row ? Link.reconstitute(structuredClone(row)) : undefined;
  }

  async findByItem(itemId: WorkItemId): Promise<Link[]> {
    return this.#rows.filter((l) => l.sourceId === itemId || l.targetId === itemId).map((l) => Link.reconstitute(structuredClone(l)));
  }

  async save(link: Link): Promise<void> {
    const row = structuredClone(link.toSnapshot());
    const idx = this.#rows.findIndex((l) => l.id === row.id);
    if (idx >= 0) this.#rows[idx] = row;
    else this.#rows.push(row);
  }

  async delete(id: LinkId): Promise<void> {
    this.#rows = this.#rows.filter((l) => l.id !== id);
  }

  rows(): WorkItemLink[] {
    return structuredClone(this.#rows);
  }

  checkpoint(): () => void {
    const rows = structuredClone(this.#rows);
    return () => {
      this.#rows = rows;
    };
  }
}
