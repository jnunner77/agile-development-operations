import type { WorkItemId } from './ids.ts';
import type { WorkItemAggregate } from './work-item.ts';

export interface RankEntry {
  readonly id: WorkItemId;
  readonly stackRank: number;
}

export interface WorkItemRepository {
  /** Reserve the next work item id. Ids are never reused. */
  nextId(): Promise<WorkItemId>;
  findById(id: WorkItemId): Promise<WorkItemAggregate | undefined>;
  findAll(): Promise<WorkItemAggregate[]>;
  findChildren(parentId: WorkItemId): Promise<WorkItemAggregate[]>;
  /** Every item's place in the backlog order, without loading the items. */
  ranks(): Promise<RankEntry[]>;
  save(item: WorkItemAggregate): Promise<void>;
  delete(id: WorkItemId): Promise<void>;
}
