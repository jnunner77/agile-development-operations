import { err, ok, type Result } from '#shared/result.ts';
import type { BackupSettings, Settings } from '../types.ts';

export const MAX_PROJECT_NAME_LENGTH = 128;
export const MAX_AREA_PATH_LENGTH = 255;
export const MAX_BACKUP_INTERVAL_HOURS = 24 * 30;
export const MAX_BACKUPS_KEPT = 365;

export type SettingsError =
  | { readonly code: 'SETTING_REQUIRED'; readonly field: 'projectName' | 'teamName' | 'workingDays' | 'areaPaths' }
  | { readonly code: 'TEXT_TOO_LONG'; readonly field: 'projectName' | 'teamName' | 'areaPaths'; readonly max: number }
  | { readonly code: 'NUMBER_OUT_OF_RANGE'; readonly field: 'workingDays' | 'intervalHours' | 'retain'; readonly min: number; readonly max: number }
  | { readonly code: 'NOT_AN_INTEGER'; readonly field: 'workingDays' | 'retain' }
  | { readonly code: 'TOO_MANY_WORKING_DAYS'; readonly max: number };

export type SettingsEvent = { readonly type: 'SettingsChanged'; readonly fields: readonly string[]; readonly occurredAt: Date };

export interface SettingsInput {
  readonly projectName?: string | undefined;
  readonly teamName?: string | undefined;
  /** 0 = Sunday ... 6 = Saturday. */
  readonly workingDays?: readonly number[] | undefined;
  readonly areaPaths?: readonly string[] | undefined;
  readonly backup?: BackupSettings | undefined;
}

type SettingsValues = { -readonly [K in keyof Settings]?: Settings[K] };

function name(field: 'projectName' | 'teamName', raw: string): Result<string, SettingsError> {
  const value = raw.trim();
  if (!value) return err({ code: 'SETTING_REQUIRED', field });
  if (value.length > MAX_PROJECT_NAME_LENGTH) return err({ code: 'TEXT_TOO_LONG', field, max: MAX_PROJECT_NAME_LENGTH });
  return ok(value);
}

/** Validated settings changes, normalised (names and area paths trimmed, working days sorted). */
export class SettingsChanges {
  readonly #values: Readonly<SettingsValues>;

  private constructor(values: SettingsValues) {
    this.#values = Object.freeze(values);
    Object.freeze(this);
  }

  static validate(input: SettingsInput): Result<SettingsChanges, SettingsError> {
    const out: SettingsValues = {};
    for (const field of ['projectName', 'teamName'] as const) {
      const raw = input[field];
      if (raw === undefined) continue;
      const value = name(field, raw);
      if (!value.ok) return value;
      out[field] = value.value;
    }
    if (input.workingDays !== undefined) {
      const days = input.workingDays;
      if (days.length < 1) return err({ code: 'SETTING_REQUIRED', field: 'workingDays' });
      if (days.length > 7) return err({ code: 'TOO_MANY_WORKING_DAYS', max: 7 });
      if (!days.every(Number.isInteger)) return err({ code: 'NOT_AN_INTEGER', field: 'workingDays' });
      if (days.some((d) => d < 0 || d > 6)) return err({ code: 'NUMBER_OUT_OF_RANGE', field: 'workingDays', min: 0, max: 6 });
      out.workingDays = [...new Set(days)].sort((a, b) => a - b);
    }
    if (input.areaPaths !== undefined) {
      if (input.areaPaths.length < 1) return err({ code: 'SETTING_REQUIRED', field: 'areaPaths' });
      const paths = input.areaPaths.map((p) => p.trim());
      if (paths.some((p) => !p)) return err({ code: 'SETTING_REQUIRED', field: 'areaPaths' });
      if (paths.some((p) => p.length > MAX_AREA_PATH_LENGTH)) return err({ code: 'TEXT_TOO_LONG', field: 'areaPaths', max: MAX_AREA_PATH_LENGTH });
      out.areaPaths = paths;
    }
    if (input.backup !== undefined) {
      const { autoEnabled, intervalHours, retain } = input.backup;
      if (!(Number.isFinite(intervalHours) && intervalHours >= 1 && intervalHours <= MAX_BACKUP_INTERVAL_HOURS)) {
        return err({ code: 'NUMBER_OUT_OF_RANGE', field: 'intervalHours', min: 1, max: MAX_BACKUP_INTERVAL_HOURS });
      }
      if (!Number.isInteger(retain)) return err({ code: 'NOT_AN_INTEGER', field: 'retain' });
      if (retain < 1 || retain > MAX_BACKUPS_KEPT) return err({ code: 'NUMBER_OUT_OF_RANGE', field: 'retain', min: 1, max: MAX_BACKUPS_KEPT });
      out.backup = { autoEnabled, intervalHours, retain };
    }
    return ok(new SettingsChanges(out));
  }

  get values(): Readonly<SettingsValues> {
    return this.#values;
  }
}

/** The project's name, team, working week, area paths and backup schedule. There is one. */
export class ProjectSettings {
  readonly #props: Settings;
  #events: SettingsEvent[] = [];

  private constructor(props: Settings) {
    this.#props = props;
  }

  static reconstitute(snapshot: Settings): ProjectSettings {
    if (!Array.isArray(snapshot.workingDays) || !Array.isArray(snapshot.areaPaths)) throw new Error('Stored settings are incomplete');
    return new ProjectSettings(copySettings(snapshot));
  }

  /** Area path for new items that have no parent to inherit one from. */
  get defaultAreaPath(): string {
    return this.#props.areaPaths[0] || this.#props.projectName;
  }

  update(changes: SettingsChanges, now: Date): void {
    const v = changes.values;
    Object.assign(this.#props, v);
    if (v.workingDays) this.#props.workingDays = [...v.workingDays];
    if (v.areaPaths) this.#props.areaPaths = [...v.areaPaths];
    if (v.backup) this.#props.backup = { ...v.backup };
    this.#events.push({ type: 'SettingsChanged', fields: Object.keys(v), occurredAt: now });
  }

  pullEvents(): readonly SettingsEvent[] {
    const events = this.#events;
    this.#events = [];
    return events;
  }

  toSnapshot(): Settings {
    return copySettings(this.#props);
  }
}

function copySettings(s: Settings): Settings {
  return { ...s, workingDays: [...s.workingDays], areaPaths: [...s.areaPaths], backup: { ...s.backup } };
}
