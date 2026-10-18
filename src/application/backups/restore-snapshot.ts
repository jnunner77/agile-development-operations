import { toSnapshotId } from '#domain/snapshots/snapshot.ts';
import { err, type Result } from '#shared/result.ts';
import { requireAdmin } from '../access.ts';
import type { Caller } from '../caller.ts';
import { replaceProject, type BackupDeps, type BackupsError, type Replaced } from './deps.ts';

/** Put the project back as a snapshot holds it, after a safety snapshot (administrators). */
export class RestoreSnapshot {
  readonly #deps: BackupDeps;

  constructor(deps: BackupDeps) {
    this.#deps = deps;
  }

  async execute(input: { readonly caller: Caller; readonly id: string }): Promise<Result<Replaced, BackupsError>> {
    const access = requireAdmin(input.caller);
    if (!access.ok) return access;
    const id = toSnapshotId(input.id);
    if (!id.ok) return id;
    const deps = this.#deps;
    return deps.project.exclusive(async (): Promise<Result<Replaced, BackupsError>> => {
      const snapshot = await deps.snapshots.find(id.value);
      const stored = await deps.snapshots.data(id.value);
      if (!snapshot || !stored) return err({ code: 'SNAPSHOT_NOT_FOUND', id: input.id });
      const data = deps.project.parse(stored.data);
      if (!data.ok) return data;
      return replaceProject(deps, input.caller, data.value, { kind: 'restore', snapshotName: snapshot.name });
    });
  }
}
