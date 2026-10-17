import type { ChangeMeta, Committed, UnitOfWork } from '#application/ports.ts';
import { ok, type Result } from '#shared/result.ts';
import type { Checkpointable } from './checkpoint.ts';

/** All-or-nothing over in-memory repositories: their state is put back if the work fails. */
export class MemoryUnitOfWork implements UnitOfWork {
  readonly #stores: readonly Checkpointable[];
  #version = 0;
  /** Every unit of work run, for assertions. */
  readonly runs: { meta: ChangeMeta; committed: boolean }[] = [];

  constructor(stores: readonly Checkpointable[]) {
    this.#stores = stores;
  }

  async run<T, E>(meta: ChangeMeta, work: () => Promise<Result<T, E>>): Promise<Result<Committed<T>, E>> {
    const restore = this.#stores.map((s) => s.checkpoint());
    const rollback = () => restore.forEach((r) => r());
    let result: Result<T, E>;
    try {
      result = await work();
    } catch (error) {
      rollback();
      this.runs.push({ meta, committed: false });
      throw error;
    }
    if (!result.ok) {
      rollback();
      this.runs.push({ meta, committed: false });
      return result;
    }
    this.runs.push({ meta, committed: true });
    return ok({ result: result.value, delta: { version: ++this.#version } });
  }
}
