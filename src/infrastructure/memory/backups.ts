import type { BackupError, ProjectCopy, ProjectStore, SnapshotRepository } from '#application/backups/ports.ts';
import type { Database } from '#application/contracts/database.ts';
import { Snapshot, type SnapshotId, type SnapshotMeta } from '#domain/snapshots/snapshot.ts';
import type { Settings } from '#domain/types.ts';
import { err, ok, type Result } from '#shared/result.ts';
import { SerialQueue } from '../serial-writes.ts';

/** Snapshots in memory, for tests. */
export class MemorySnapshotRepository implements SnapshotRepository {
  readonly #snapshots = new Map<string, { meta: SnapshotMeta; json: string }>();

  async all(): Promise<Snapshot[]> {
    return [...this.#snapshots.values()].map((s) => Snapshot.reconstitute(s.meta));
  }

  async find(id: SnapshotId): Promise<Snapshot | undefined> {
    const stored = this.#snapshots.get(id);
    return stored ? Snapshot.reconstitute(stored.meta) : undefined;
  }

  async add(snapshot: Snapshot, copy: ProjectCopy): Promise<void> {
    this.#snapshots.set(snapshot.id, { meta: snapshot.toMeta(), json: copy.json });
  }

  async update(snapshot: Snapshot): Promise<void> {
    const stored = this.#snapshots.get(snapshot.id);
    if (stored) this.#snapshots.set(snapshot.id, { ...stored, meta: snapshot.toMeta() });
  }

  async delete(id: SnapshotId): Promise<void> {
    this.#snapshots.delete(id);
  }

  async data(id: SnapshotId): Promise<{ readonly data: unknown } | undefined> {
    const stored = this.#snapshots.get(id);
    return stored ? { data: JSON.parse(stored.json) } : undefined;
  }

  async file(id: SnapshotId): Promise<Uint8Array | undefined> {
    const stored = this.#snapshots.get(id);
    return stored ? new TextEncoder().encode(JSON.stringify({ meta: stored.meta, data: JSON.parse(stored.json) })) : undefined;
  }
}

/**
 * The project as one document in memory, for tests. `parse` accepts an object with the
 * database's lists; `demo` is a fixed small project.
 */
export class MemoryProject implements ProjectStore {
  data: Database;
  /** Every replacement, for assertions. */
  readonly replaced: { data: Database; origin: string | undefined }[] = [];
  readonly #writes = new SerialQueue();
  readonly #demo: () => Database;

  constructor(data: Database, demo: () => Database) {
    this.data = data;
    this.#demo = demo;
  }

  capture(): ProjectCopy {
    const json = JSON.stringify(this.data);
    return { data: structuredClone(this.data), json, sizeBytes: json.length };
  }

  parse(raw: unknown): Result<Database, BackupError> {
    const looksLikeDatabase = (v: unknown): v is Database =>
      typeof v === 'object' && v !== null && ['workItems', 'sprints', 'members'].every((k) => Array.isArray(Reflect.get(v, k)));
    return looksLikeDatabase(raw) ? ok(structuredClone(raw)) : err({ code: 'INVALID_BACKUP', reason: 'Backup is missing the "workItems" list' });
  }

  blank(settings: Settings): Database {
    return { ...structuredClone(this.data), settings: structuredClone(settings), members: [], sprints: [], capacities: [], workItems: [], links: [], recycleBin: [], nextWorkItemId: 1 };
  }

  demo(): Database {
    return this.#demo();
  }

  replace(data: Database, origin: string | undefined): void {
    this.data = structuredClone(data);
    this.replaced.push({ data: structuredClone(data), origin });
  }

  exclusive<T>(work: () => Promise<T>): Promise<T> {
    return this.#writes.run(work);
  }
}
