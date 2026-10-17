import type { CapacityRepository, SprintRepository } from '#domain/sprints/repository.ts';
import { CapacityPlan } from '#domain/sprints/capacity-plan.ts';
import { Sprint, type SprintId } from '#domain/sprints/sprint.ts';
import type { CurrentTransaction } from './unit-of-work.ts';

export class JsonSprintRepository implements SprintRepository {
  readonly #tx: CurrentTransaction;

  constructor(tx: CurrentTransaction) {
    this.#tx = tx;
  }

  async findById(id: SprintId): Promise<Sprint | undefined> {
    const row = this.#tx.current().db.sprints.find((s) => s.id === id);
    return row ? Sprint.reconstitute(row) : undefined;
  }

  async findAll(): Promise<Sprint[]> {
    return this.#tx.current().db.sprints.map((s) => Sprint.reconstitute(s));
  }

  async save(sprint: Sprint): Promise<void> {
    const tx = this.#tx.current();
    const row = sprint.toSnapshot();
    const idx = tx.db.sprints.findIndex((s) => s.id === row.id);
    if (idx >= 0) tx.db.sprints[idx] = row;
    else tx.db.sprints.push(row);
    tx.sprints.add(row.id);
  }

  async delete(id: SprintId): Promise<void> {
    const tx = this.#tx.current();
    tx.db.sprints = tx.db.sprints.filter((s) => s.id !== id);
    tx.deletedSprints.add(id);
  }
}

export class JsonCapacityRepository implements CapacityRepository {
  readonly #tx: CurrentTransaction;

  constructor(tx: CurrentTransaction) {
    this.#tx = tx;
  }

  async findBySprint(sprintId: SprintId): Promise<CapacityPlan | undefined> {
    const row = this.#tx.current().db.capacities.find((c) => c.sprintId === sprintId);
    return row ? CapacityPlan.reconstitute(row) : undefined;
  }

  async findAll(): Promise<CapacityPlan[]> {
    return this.#tx.current().db.capacities.map((c) => CapacityPlan.reconstitute(c));
  }

  async save(plan: CapacityPlan): Promise<void> {
    const tx = this.#tx.current();
    const row = plan.toSnapshot();
    const idx = tx.db.capacities.findIndex((c) => c.sprintId === row.sprintId);
    if (idx >= 0) tx.db.capacities[idx] = row;
    else tx.db.capacities.push(row);
    tx.capacities.add(row.sprintId);
  }

  /** Browsers drop a deleted sprint's plan along with the sprint, so nothing else is reported. */
  async delete(sprintId: SprintId): Promise<void> {
    const tx = this.#tx.current();
    tx.db.capacities = tx.db.capacities.filter((c) => c.sprintId !== sprintId);
  }
}
