import type { ProjectSettings } from './project-settings.ts';

export interface SettingsRepository {
  get(): Promise<ProjectSettings>;
  save(settings: ProjectSettings): Promise<void>;
}
