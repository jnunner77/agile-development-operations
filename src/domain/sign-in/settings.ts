import { err, ok, type Result } from '#shared/result.ts';

export interface SignInSettingsData {
  /** When false the app works as before: anyone can pick who they are acting as. */
  enabled: boolean;
  /** Days before a password must be changed. 0 means passwords never expire. */
  passwordExpiryDays: number;
  /** Minutes of inactivity before a signed-in user is signed out. */
  sessionTimeoutMinutes: number;
}

export const DEFAULT_SIGN_IN_SETTINGS: Readonly<SignInSettingsData> = Object.freeze({
  enabled: false,
  passwordExpiryDays: 60,
  sessionTimeoutMinutes: 60,
});

export const EXPIRY_DAYS_MAX = 3650;
export const SESSION_TIMEOUT_MIN = 5;
export const SESSION_TIMEOUT_MAX = 7 * 24 * 60;

export type SignInSettingsError =
  | { readonly code: 'NOT_AN_INTEGER'; readonly field: 'passwordExpiryDays' | 'sessionTimeoutMinutes' }
  | { readonly code: 'NUMBER_OUT_OF_RANGE'; readonly field: 'passwordExpiryDays' | 'sessionTimeoutMinutes'; readonly min: number; readonly max: number }
  | { readonly code: 'SIGN_IN_NEEDS_ADMIN' };

export type SignInSettingsEvent = { readonly type: 'SignInSettingsChanged'; readonly enabled: boolean; readonly occurredAt: Date };

export interface SignInSettingsInput {
  readonly enabled?: boolean | undefined;
  readonly passwordExpiryDays?: number | undefined;
  readonly sessionTimeoutMinutes?: number | undefined;
}

type Values = { -readonly [K in keyof SignInSettingsData]?: SignInSettingsData[K] };

function wholeNumberIn(field: 'passwordExpiryDays' | 'sessionTimeoutMinutes', value: number, min: number, max: number): Result<number, SignInSettingsError> {
  if (!Number.isInteger(value)) return err({ code: 'NOT_AN_INTEGER', field });
  if (value < min || value > max) return err({ code: 'NUMBER_OUT_OF_RANGE', field, min, max });
  return ok(value);
}

export class SignInSettingsChanges {
  readonly #values: Readonly<Values>;

  private constructor(values: Values) {
    this.#values = Object.freeze(values);
    Object.freeze(this);
  }

  static validate(input: SignInSettingsInput): Result<SignInSettingsChanges, SignInSettingsError> {
    const out: Values = {};
    if (input.enabled !== undefined) out.enabled = input.enabled;
    if (input.passwordExpiryDays !== undefined) {
      const days = wholeNumberIn('passwordExpiryDays', input.passwordExpiryDays, 0, EXPIRY_DAYS_MAX);
      if (!days.ok) return days;
      out.passwordExpiryDays = days.value;
    }
    if (input.sessionTimeoutMinutes !== undefined) {
      const minutes = wholeNumberIn('sessionTimeoutMinutes', input.sessionTimeoutMinutes, SESSION_TIMEOUT_MIN, SESSION_TIMEOUT_MAX);
      if (!minutes.ok) return minutes;
      out.sessionTimeoutMinutes = minutes.value;
    }
    return ok(new SignInSettingsChanges(out));
  }

  get values(): Readonly<Values> {
    return this.#values;
  }
}

/** How sign-in works for the project: whether it is on, and how long passwords and sessions last. */
export class SignInSettings {
  readonly #props: SignInSettingsData;
  #events: SignInSettingsEvent[] = [];

  private constructor(props: SignInSettingsData) {
    this.#props = props;
  }

  /** Stored settings, with defaults for anything missing. */
  static reconstitute(stored: Partial<SignInSettingsData> | undefined): SignInSettings {
    return new SignInSettings({ ...DEFAULT_SIGN_IN_SETTINGS, ...stored });
  }

  get enabled(): boolean {
    return this.#props.enabled;
  }
  get passwordExpiryDays(): number {
    return this.#props.passwordExpiryDays;
  }
  get sessionTimeoutMinutes(): number {
    return this.#props.sessionTimeoutMinutes;
  }

  /**
   * Change the settings. Sign-in can only be on while some administrator can sign in, otherwise
   * nobody could; that holds even while it is forced off, so a restart can't lock everyone out.
   */
  update(changes: SignInSettingsChanges, usableAdminExists: boolean, now: Date): Result<void, SignInSettingsError> {
    const next = { ...this.#props, ...changes.values };
    if (next.enabled && !usableAdminExists) return err({ code: 'SIGN_IN_NEEDS_ADMIN' });
    Object.assign(this.#props, next);
    this.#events.push({ type: 'SignInSettingsChanged', enabled: next.enabled, occurredAt: now });
    return ok(undefined);
  }

  pullEvents(): readonly SignInSettingsEvent[] {
    const events = this.#events;
    this.#events = [];
    return events;
  }

  toSnapshot(): SignInSettingsData {
    return { ...this.#props };
  }
}
