import type { BackupError, ProjectCopy, ProjectStore } from '#application/backups/ports.ts';
import type { Database } from '#application/contracts/database.ts';
import type { Settings } from '#domain/types.ts';
import { err, ok, type Result } from '#shared/result.ts';
import { buildDemoDatabase } from './demo-project.ts';
import { emptyDatabase, normalizeDatabase } from './schema.ts';
import type { Store } from './store.ts';

/** The JSON store's database as one document. */
export class StoreProject implements ProjectStore {
  readonly #store: Store;

  constructor(store: Store) {
    this.#store = store;
  }

  capture(): ProjectCopy {
    const data = this.#store.db;
    // Serialized only when a snapshot is written; exports and settings reads don't need it.
    let json: string | undefined;
    const serialized = () => (json ??= JSON.stringify(data));
    return {
      data,
      get json() {
        return serialized();
      },
      get sizeBytes() {
        return Buffer.byteLength(serialized());
      },
    };
  }

  parse(raw: unknown): Result<Database, BackupError> {
    try {
      return ok(normalizeDatabase(raw));
    } catch (error) {
      return err({ code: 'INVALID_BACKUP', reason: error instanceof Error ? error.message : 'Invalid backup file' });
    }
  }

  blank(settings: Settings): Database {
    return emptyDatabase(settings);
  }

  demo(): Database {
    return buildDemoDatabase();
  }

  replace(data: Database, origin: string | undefined): void {
    this.#store.replace(data, origin);
  }

  exclusive<T>(work: () => Promise<T>): Promise<T> {
    return this.#store.writes.run(work);
  }
}
