import type { CapacityPlan } from './capacity-plan.ts';
import type { Sprint, SprintId } from './sprint.ts';

export interface SprintRepository {
  findById(id: SprintId): Promise<Sprint | undefined>;
  findAll(): Promise<Sprint[]>;
  save(sprint: Sprint): Promise<void>;
  delete(id: SprintId): Promise<void>;
}

export interface CapacityRepository {
  findBySprint(sprintId: SprintId): Promise<CapacityPlan | undefined>;
  findAll(): Promise<CapacityPlan[]>;
  save(plan: CapacityPlan): Promise<void>;
  delete(sprintId: SprintId): Promise<void>;
}
