import { CapacityPlan } from '#domain/sprints/capacity-plan.ts';
import type { CapacityRepository, SprintRepository } from '#domain/sprints/repository.ts';
import { Sprint, type SprintId } from '#domain/sprints/sprint.ts';
import type { Sprint as SprintData, SprintCapacity } from '#domain/types.ts';
import type { Checkpointable } from './checkpoint.ts';

export class MemorySprintRepository implements SprintRepository, Checkpointable {
  #rows: SprintData[];

  constructor(rows: readonly SprintData[] = []) {
    this.#rows = structuredClone([...rows]);
  }

  async findById(id: SprintId): Promise<Sprint | undefined> {
    const row = this.#rows.find((s) => s.id === id);
    return row ? Sprint.reconstitute(structuredClone(row)) : undefined;
  }

  async findAll(): Promise<Sprint[]> {
    return this.#rows.map((s) => Sprint.reconstitute(structuredClone(s)));
  }

  async save(sprint: Sprint): Promise<void> {
    const row = structuredClone(sprint.toSnapshot());
    const idx = this.#rows.findIndex((s) => s.id === row.id);
    if (idx >= 0) this.#rows[idx] = row;
    else this.#rows.push(row);
  }

  async delete(id: SprintId): Promise<void> {
    this.#rows = this.#rows.filter((s) => s.id !== id);
  }

  rows(): SprintData[] {
    return structuredClone(this.#rows);
  }

  checkpoint(): () => void {
    const rows = structuredClone(this.#rows);
    return () => {
      this.#rows = rows;
    };
  }
}

export class MemoryCapacityRepository implements CapacityRepository, Checkpointable {
  #rows: SprintCapacity[] = [];

  async findBySprint(sprintId: SprintId): Promise<CapacityPlan | undefined> {
    const row = this.#rows.find((c) => c.sprintId === sprintId);
    return row ? CapacityPlan.reconstitute(structuredClone(row)) : undefined;
  }

  async findAll(): Promise<CapacityPlan[]> {
    return this.#rows.map((c) => CapacityPlan.reconstitute(structuredClone(c)));
  }

  async save(plan: CapacityPlan): Promise<void> {
    const row = structuredClone(plan.toSnapshot());
    const idx = this.#rows.findIndex((c) => c.sprintId === row.sprintId);
    if (idx >= 0) this.#rows[idx] = row;
    else this.#rows.push(row);
  }

  async delete(sprintId: SprintId): Promise<void> {
    this.#rows = this.#rows.filter((c) => c.sprintId !== sprintId);
  }

  rows(): SprintCapacity[] {
    return structuredClone(this.#rows);
  }

  checkpoint(): () => void {
    const rows = structuredClone(this.#rows);
    return () => {
      this.#rows = rows;
    };
  }
}
