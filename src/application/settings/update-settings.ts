import { SettingsChanges, type SettingsError, type SettingsInput } from '#domain/settings/project-settings.ts';
import type { Settings } from '#domain/types.ts';
import { ok, type Result } from '#shared/result.ts';
import { requireAdmin, type AccessError } from '../access.ts';
import type { Caller } from '../caller.ts';
import type { AppDeps } from '../deps.ts';
import type { Committed } from '../ports.ts';
import { runChange } from '../session.ts';

export type SettingsDeps = Pick<AppDeps, 'settings' | 'clock' | 'ids' | 'events' | 'unitOfWork'>;

export interface UpdateSettingsInput extends SettingsInput {
  readonly caller: Caller;
}

export class UpdateSettings {
  readonly #deps: SettingsDeps;

  constructor(deps: SettingsDeps) {
    this.#deps = deps;
  }

  async execute(input: UpdateSettingsInput): Promise<Result<Committed<Settings>, SettingsError | AccessError>> {
    const access = requireAdmin(input.caller);
    if (!access.ok) return access;
    const changes = SettingsChanges.validate(input);
    if (!changes.ok) return changes;
    return runChange(this.#deps, input.caller, async (session) => {
      const settings = await this.#deps.settings.get();
      settings.update(changes.value, session.now);
      await this.#deps.settings.save(settings);
      session.record(settings);
      return ok(settings.toSnapshot());
    });
  }
}
