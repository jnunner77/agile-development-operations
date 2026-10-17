import type { Account } from './account.ts';
import type { FailedAttempts } from './lockout.ts';
import type { Session } from './session.ts';
import type { SignInSettings } from './settings.ts';

export interface AccountRepository {
  /** The member's account, or a blank one if it was never set up. */
  get(memberId: string): Promise<Account>;
  all(): Promise<Account[]>;
  save(account: Account): Promise<void>;
}

export interface SignInSettingsRepository {
  get(): Promise<SignInSettings>;
  save(settings: SignInSettings): Promise<void>;
}

export interface SessionRepository {
  find(token: string): Promise<Session | undefined>;
  forMember(memberId: string): Promise<Session[]>;
  all(): Promise<Session[]>;
  save(session: Session): Promise<void>;
  delete(token: string): Promise<void>;
}

export interface FailedAttemptsRepository {
  find(key: string): Promise<FailedAttempts | undefined>;
  all(): Promise<[string, FailedAttempts][]>;
  save(key: string, record: FailedAttempts): Promise<void>;
  delete(key: string): Promise<void>;
}
