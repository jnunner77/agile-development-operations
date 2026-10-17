import { settingsKeptOnReset } from '#domain/snapshots/snapshot.ts';
import type { Result } from '#shared/result.ts';
import { requireAdmin } from '../access.ts';
import type { Caller } from '../caller.ts';
import { replaceProject, type BackupDeps, type BackupsError, type Replaced } from './deps.ts';

export interface ResetProjectInput {
  readonly caller: Caller;
  /** An empty project that keeps the settings, or the demo project. */
  readonly mode: 'empty' | 'demo';
}

/** Start the project over, after a safety snapshot (administrators). */
export class ResetProject {
  readonly #deps: BackupDeps;

  constructor(deps: BackupDeps) {
    this.#deps = deps;
  }

  async execute(input: ResetProjectInput): Promise<Result<Replaced, BackupsError>> {
    const access = requireAdmin(input.caller);
    if (!access.ok) return access;
    const deps = this.#deps;
    return deps.project.exclusive(() => {
      const { project } = deps;
      const data = input.mode === 'demo' ? project.demo() : project.blank(settingsKeptOnReset(project.capture().data.settings));
      return replaceProject(deps, input.caller, data, { kind: 'reset', mode: input.mode });
    });
  }
}
