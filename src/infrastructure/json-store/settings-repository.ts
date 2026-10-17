import type { SettingsRepository } from '#domain/settings/repository.ts';
import { ProjectSettings } from '#domain/settings/project-settings.ts';
import type { CurrentTransaction } from './unit-of-work.ts';

export class JsonSettingsRepository implements SettingsRepository {
  readonly #tx: CurrentTransaction;

  constructor(tx: CurrentTransaction) {
    this.#tx = tx;
  }

  async get(): Promise<ProjectSettings> {
    return ProjectSettings.reconstitute(this.#tx.current().db.settings);
  }

  async save(settings: ProjectSettings): Promise<void> {
    const tx = this.#tx.current();
    tx.db.settings = settings.toSnapshot();
    tx.settings = true;
  }
}
