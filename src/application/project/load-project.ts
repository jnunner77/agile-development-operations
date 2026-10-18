import type { AppDeps } from '../deps.ts';
import type { Database } from '../contracts/database.ts';

export interface LoadedProject {
  readonly db: Database;
  /** The server's clock, so browsers can tell how far theirs is off. */
  readonly serverTime: string;
}

/**
 * The whole project for a browser to start from. Everything in it may be seen by anyone who can
 * use the app; secrets live in their own files and never reach it.
 */
export class LoadProject {
  readonly #deps: Pick<AppDeps, 'project' | 'clock'>;

  constructor(deps: Pick<AppDeps, 'project' | 'clock'>) {
    this.#deps = deps;
  }

  async execute(): Promise<LoadedProject> {
    return { db: this.#deps.project.capture().data, serverTime: this.#deps.clock.now().toISOString() };
  }
}
