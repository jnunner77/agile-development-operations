import { SnapshotDetails, toSnapshotId, type SnapshotDetailsInput, type SnapshotError, type SnapshotMeta } from '#domain/snapshots/snapshot.ts';
import { err, ok, type Result } from '#shared/result.ts';
import { requireAdmin, type AccessError } from '../access.ts';
import type { Caller } from '../caller.ts';
import type { BackupDeps } from './deps.ts';

export interface UpdateSnapshotInput extends SnapshotDetailsInput {
  readonly caller: Caller;
  readonly id: string;
}

/** Rename a snapshot or change its description (administrators). */
export class UpdateSnapshot {
  readonly #deps: BackupDeps;

  constructor(deps: BackupDeps) {
    this.#deps = deps;
  }

  async execute(input: UpdateSnapshotInput): Promise<Result<SnapshotMeta, SnapshotError | AccessError>> {
    const access = requireAdmin(input.caller);
    if (!access.ok) return access;
    const details = SnapshotDetails.validate(input);
    if (!details.ok) return details;
    const id = toSnapshotId(input.id);
    if (!id.ok) return id;
    const deps = this.#deps;
    return deps.project.exclusive(async (): Promise<Result<SnapshotMeta, SnapshotError>> => {
      const snapshot = await deps.snapshots.find(id.value);
      if (!snapshot) return err({ code: 'SNAPSHOT_NOT_FOUND', id: input.id });
      snapshot.update(details.value, deps.clock.now());
      await deps.snapshots.update(snapshot);
      await deps.events.publish(snapshot.pullEvents());
      return ok(snapshot.toMeta());
    });
  }
}
