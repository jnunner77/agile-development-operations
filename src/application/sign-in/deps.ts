import type { ApiTokenError } from '#domain/api-tokens/api-token.ts';
import type { DomainEvent } from '#domain/events.ts';
import type { PasswordError } from '#domain/sign-in/password.ts';
import type { SignInSettings, SignInSettingsError } from '#domain/sign-in/settings.ts';
import type { MemberError } from '#domain/team/member.ts';
import type { AccessError } from '../access.ts';
import type { AppDeps } from '../deps.ts';

export type SignInDeps = Pick<
  AppDeps,
  'accounts' | 'signInSettings' | 'sessions' | 'failedAttempts' | 'apiTokens' | 'team' | 'hasher' | 'secrets' | 'clock' | 'ids' | 'events' | 'signInForcedOff'
>;

export type SignInError =
  | { readonly code: 'SIGN_IN_OFF' }
  | { readonly code: 'SIGN_IN_LOCKED'; readonly minutes: number }
  | { readonly code: 'INVALID_CREDENTIALS' }
  | { readonly code: 'WRONG_CURRENT_PASSWORD' }
  | { readonly code: 'PASSWORD_UNCHANGED' }
  | { readonly code: 'PASSWORD_CHANGED_MEANWHILE' }
  | { readonly code: 'USERNAME_REQUIRED' }
  | { readonly code: 'TEXT_TOO_LONG'; readonly field: 'username'; readonly max: number }
  | { readonly code: 'USERNAME_MISSING'; readonly name: string }
  | { readonly code: 'ACCOUNT_IS_LAST_ADMIN' }
  | PasswordError
  | SignInSettingsError
  | MemberError
  | AccessError;

export type ApiTokensError = ApiTokenError | MemberError | AccessError;

/** The settings, and whether sign-in is actually on: enabled and not forced off. */
export async function signInState(deps: Pick<SignInDeps, 'signInSettings' | 'signInForcedOff'>): Promise<{ settings: SignInSettings; enabled: boolean }> {
  const settings = await deps.signInSettings.get();
  return { settings, enabled: settings.enabled && !deps.signInForcedOff };
}

/** Publish the events an operation recorded. Sign-in changes don't run in a unit of work. */
export async function publish(deps: Pick<SignInDeps, 'events'>, ...sources: { pullEvents(): readonly DomainEvent[] }[]): Promise<void> {
  const events = sources.flatMap((s) => s.pullEvents());
  if (events.length) await deps.events.publish(events);
}
