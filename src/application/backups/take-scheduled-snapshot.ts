import { scheduledSnapshotDue, type SnapshotMeta } from '#domain/snapshots/snapshot.ts';
import { takeSnapshot, type BackupDeps } from './deps.ts';

/**
 * Take an automatic snapshot if one is due by the backup settings, and delete automatic ones
 * beyond the number to keep. Run every few minutes by the server. Returns the snapshot taken.
 */
export class TakeScheduledSnapshot {
  readonly #deps: BackupDeps;

  constructor(deps: BackupDeps) {
    this.#deps = deps;
  }

  async execute(): Promise<SnapshotMeta | null> {
    const deps = this.#deps;
    return deps.project.exclusive(async () => {
      const settings = deps.project.capture().data.settings.backup;
      if (!scheduledSnapshotDue(settings, await deps.snapshots.all(), deps.clock.now())) return null;
      const taken = await takeSnapshot(deps, { kind: 'auto', name: '', description: 'Scheduled automatic backup', createdBy: 'System' });
      return taken.ok ? taken.value.toMeta() : null;
    });
  }
}
