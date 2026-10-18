import type { Snapshot, SnapshotId } from '#domain/snapshots/snapshot.ts';
import type { Settings } from '#domain/types.ts';
import type { Result } from '#shared/result.ts';
import type { Database } from '../contracts/database.ts';

/** The whole project as it is now, serialized once (snapshots and exports are written from it). */
export interface ProjectCopy {
  readonly data: Database;
  readonly json: string;
  readonly sizeBytes: number;
}

export type BackupError = { readonly code: 'INVALID_BACKUP'; readonly reason: string };

/** The project as one document: read it whole, check a replacement for it, replace it. */
export interface ProjectStore {
  capture(): ProjectCopy;
  /** Read a backup: a bare database, an export, or a snapshot file. Missing fields get defaults. */
  parse(raw: unknown): Result<Database, BackupError>;
  /** An empty project with these settings. */
  blank(settings: Settings): Database;
  /** The demo project, dated around today. */
  demo(): Database;
  /** Replace the whole project; every open browser reloads it. */
  replace(data: Database, origin: string | undefined): void;
  /** Run `work` with no other change to the project committing meanwhile. */
  exclusive<T>(work: () => Promise<T>): Promise<T>;
}

/**
 * Snapshots and the copies of the project they hold. It sits in the application rather than the
 * domain because what it stores is the whole project document.
 */
export interface SnapshotRepository {
  /** Every snapshot whose copy still exists. */
  all(): Promise<Snapshot[]>;
  find(id: SnapshotId): Promise<Snapshot | undefined>;
  add(snapshot: Snapshot, copy: ProjectCopy): Promise<void>;
  update(snapshot: Snapshot): Promise<void>;
  delete(id: SnapshotId): Promise<void>;
  /** The project as the snapshot holds it, unchecked, or undefined if there is no such snapshot. */
  data(id: SnapshotId): Promise<{ readonly data: unknown } | undefined>;
  /** The snapshot file exactly as stored, for downloading. */
  file(id: SnapshotId): Promise<AsyncIterable<Uint8Array> | undefined>;
}
