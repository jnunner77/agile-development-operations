import { newestFirst, type SnapshotMeta } from '#domain/snapshots/snapshot.ts';
import type { BackupDeps } from './deps.ts';

/** Every snapshot, newest first. */
export class ListSnapshots {
  readonly #deps: Pick<BackupDeps, 'snapshots'>;

  constructor(deps: Pick<BackupDeps, 'snapshots'>) {
    this.#deps = deps;
  }

  async execute(): Promise<SnapshotMeta[]> {
    return newestFirst(await this.#deps.snapshots.all()).map((s) => s.toMeta());
  }
}
