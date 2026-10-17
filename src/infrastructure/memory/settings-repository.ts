import { ProjectSettings } from '#domain/settings/project-settings.ts';
import type { SettingsRepository } from '#domain/settings/repository.ts';
import type { Settings } from '#domain/types.ts';
import type { Checkpointable } from './checkpoint.ts';

export const DEFAULT_TEST_SETTINGS: Settings = {
  projectName: 'Fabrikam',
  teamName: 'Fabrikam Team',
  workingDays: [1, 2, 3, 4, 5],
  areaPaths: ['Fabrikam'],
  backup: { autoEnabled: true, intervalHours: 24, retain: 14 },
};

export class MemorySettingsRepository implements SettingsRepository, Checkpointable {
  #row: Settings;

  constructor(row: Settings = DEFAULT_TEST_SETTINGS) {
    this.#row = structuredClone(row);
  }

  async get(): Promise<ProjectSettings> {
    return ProjectSettings.reconstitute(structuredClone(this.#row));
  }

  async save(settings: ProjectSettings): Promise<void> {
    this.#row = structuredClone(settings.toSnapshot());
  }

  row(): Settings {
    return structuredClone(this.#row);
  }

  checkpoint(): () => void {
    const row = structuredClone(this.#row);
    return () => {
      this.#row = row;
    };
  }
}
