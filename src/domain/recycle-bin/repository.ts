import type { WorkItemId } from '../work-items/ids.ts';
import type { DeletedWorkItem } from './deleted-work-item.ts';

export interface RecycleBinRepository {
  findById(id: WorkItemId): Promise<DeletedWorkItem | undefined>;
  /** Most recently deleted first. */
  add(entry: DeletedWorkItem): Promise<void>;
  remove(id: WorkItemId): Promise<void>;
}
