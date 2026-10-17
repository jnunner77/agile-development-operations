import type { ProjectDirectory } from '#application/ports.ts';
import type { CurrentTransaction } from './unit-of-work.ts';

/** Sprints, members and settings as they are in the running unit of work. */
export class JsonProjectDirectory implements ProjectDirectory {
  readonly #tx: CurrentTransaction;

  constructor(tx: CurrentTransaction) {
    this.#tx = tx;
  }

  async memberExists(id: string): Promise<boolean> {
    return this.#tx.current().db.members.some((m) => m.id === id);
  }

  async sprintExists(id: string): Promise<boolean> {
    return this.#tx.current().db.sprints.some((s) => s.id === id);
  }

  /** The first configured area path, else the project's name. */
  async defaultAreaPath(): Promise<string> {
    const { settings } = this.#tx.current().db;
    return settings.areaPaths[0] || settings.projectName;
  }
}
