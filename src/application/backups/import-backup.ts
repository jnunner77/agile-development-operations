import { err, type Result } from '#shared/result.ts';
import { requireAdmin } from '../access.ts';
import type { Caller } from '../caller.ts';
import { replaceProject, type BackupDeps, type BackupsError, type Replaced } from './deps.ts';

export interface ImportBackupInput {
  readonly caller: Caller;
  /** The uploaded file's JSON: an export, a snapshot file or a bare database. */
  readonly file: unknown;
}

/** Replace the project with a backup, after a safety snapshot (administrators). */
export class ImportBackup {
  readonly #deps: BackupDeps;

  constructor(deps: BackupDeps) {
    this.#deps = deps;
  }

  async execute(input: ImportBackupInput): Promise<Result<Replaced, BackupsError>> {
    const access = requireAdmin(input.caller);
    if (!access.ok) return access;
    const deps = this.#deps;
    const data = deps.project.parse(input.file);
    if (!data.ok) return err(data.error);
    return deps.project.exclusive(() => replaceProject(deps, input.caller, data.value, { kind: 'import' }));
  }
}
