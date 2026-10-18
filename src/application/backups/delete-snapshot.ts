import { toSnapshotId, type SnapshotError } from '#domain/snapshots/snapshot.ts';
import { err, ok, type Result } from '#shared/result.ts';
import { requireAdmin, type AccessError } from '../access.ts';
import type { Caller } from '../caller.ts';
import type { BackupDeps } from './deps.ts';

/** Delete a snapshot and its copy of the project (administrators). */
export class DeleteSnapshot {
  readonly #deps: BackupDeps;

  constructor(deps: BackupDeps) {
    this.#deps = deps;
  }

  async execute(input: { readonly caller: Caller; readonly id: string }): Promise<Result<void, SnapshotError | AccessError>> {
    const access = requireAdmin(input.caller);
    if (!access.ok) return access;
    const id = toSnapshotId(input.id);
    if (!id.ok) return id;
    const deps = this.#deps;
    return deps.project.exclusive(async (): Promise<Result<void, SnapshotError>> => {
      const snapshot = await deps.snapshots.find(id.value);
      if (!snapshot) return err({ code: 'SNAPSHOT_NOT_FOUND', id: input.id });
      await deps.snapshots.delete(id.value);
      snapshot.remove(deps.clock.now());
      await deps.events.publish(snapshot.pullEvents());
      return ok(undefined);
    });
  }
}
