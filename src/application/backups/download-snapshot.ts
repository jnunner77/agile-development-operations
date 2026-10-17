import { toSnapshotId, type SnapshotError } from '#domain/snapshots/snapshot.ts';
import { err, ok, type Result } from '#shared/result.ts';
import type { BackupDeps } from './deps.ts';

export interface SnapshotDownload {
  readonly fileName: string;
  /** The snapshot file as stored: `{ format, meta, data }`. */
  readonly contents: Uint8Array;
}

/** A snapshot's file, to save elsewhere or import into another server. */
export class DownloadSnapshot {
  readonly #deps: Pick<BackupDeps, 'snapshots'>;

  constructor(deps: Pick<BackupDeps, 'snapshots'>) {
    this.#deps = deps;
  }

  async execute(input: { readonly id: string }): Promise<Result<SnapshotDownload, SnapshotError>> {
    const id = toSnapshotId(input.id);
    if (!id.ok) return id;
    const contents = await this.#deps.snapshots.file(id.value);
    if (!contents) return err({ code: 'SNAPSHOT_NOT_FOUND', id: input.id });
    return ok({ fileName: `snapshot-${id.value}.json`, contents });
  }
}
