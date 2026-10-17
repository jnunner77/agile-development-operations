import { SnapshotDetails, type SnapshotDetailsInput, type SnapshotError, type SnapshotMeta } from '#domain/snapshots/snapshot.ts';
import { ok, type Result } from '#shared/result.ts';
import type { Caller } from '../caller.ts';
import { takeSnapshot, type BackupDeps } from './deps.ts';

export interface TakeSnapshotInput extends SnapshotDetailsInput {
  readonly caller: Caller;
}

/** Take a snapshot by hand. Anyone may; there can be at most `MAX_MANUAL_SNAPSHOTS` of them. */
export class TakeSnapshot {
  readonly #deps: BackupDeps;

  constructor(deps: BackupDeps) {
    this.#deps = deps;
  }

  async execute(input: TakeSnapshotInput): Promise<Result<SnapshotMeta, SnapshotError>> {
    const details = SnapshotDetails.validate(input);
    if (!details.ok) return details;
    const deps = this.#deps;
    const taken = await deps.project.exclusive(() =>
      takeSnapshot(deps, { kind: 'manual', name: details.value.name ?? '', description: details.value.description ?? '', createdBy: input.caller.name }),
    );
    return taken.ok ? ok(taken.value.toMeta()) : taken;
  }
}
