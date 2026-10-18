import type { AppDeps } from '../deps.ts';
import type { ChangeListener } from '../ports.ts';

export interface Watching {
  /** The project's version when watching started. */
  readonly version: number;
  stop(): void;
}

/** Follow every committed change, for a browser's live update stream. */
export class WatchChanges {
  readonly #deps: Pick<AppDeps, 'project' | 'changes'>;

  constructor(deps: Pick<AppDeps, 'project' | 'changes'>) {
    this.#deps = deps;
  }

  execute(listener: ChangeListener): Watching {
    const version = this.#deps.project.capture().data.version;
    const stop = this.#deps.changes.subscribe(listener);
    return { version, stop };
  }
}
