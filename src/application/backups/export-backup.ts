import { backupFileName } from '#domain/snapshots/snapshot.ts';
import type { Caller } from '../caller.ts';
import type { BackupFile } from '../contracts/database.ts';
import type { BackupDeps } from './deps.ts';

export interface BackupExport {
  readonly fileName: string;
  readonly file: BackupFile;
}

/** The whole project as a file anyone can download. Secrets are never part of it. */
export class ExportBackup {
  readonly #deps: Pick<BackupDeps, 'project' | 'clock'>;

  constructor(deps: Pick<BackupDeps, 'project' | 'clock'>) {
    this.#deps = deps;
  }

  async execute(input: { readonly caller: Caller }): Promise<BackupExport> {
    const now = this.#deps.clock.now();
    const { data } = this.#deps.project.capture();
    return {
      fileName: backupFileName(data.settings.projectName, now),
      file: { format: 'ado-clone-backup', exportedAt: now.toISOString(), exportedBy: input.caller.name, data },
    };
  }
}
