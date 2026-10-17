import type { WorkItemId } from '../work-items/ids.ts';
import type { Link, LinkId } from './link.ts';

export interface LinkRepository {
  findById(id: LinkId): Promise<Link | undefined>;
  /** Links with the item at either end. */
  findByItem(itemId: WorkItemId): Promise<Link[]>;
  save(link: Link): Promise<void>;
  delete(id: LinkId): Promise<void>;
}
