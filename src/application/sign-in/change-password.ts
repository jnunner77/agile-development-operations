import type { Account } from '#domain/sign-in/account.ts';
import { lockoutKey } from '#domain/sign-in/lockout.ts';
import { checkNewPassword, checkPresentedPassword } from '#domain/sign-in/password.ts';
import { checkTypedUsername, memberForUsername } from '#domain/sign-in/usernames.ts';
import { err, ok, type Result } from '#shared/result.ts';
import type { AuthUser } from '../contracts/auth.ts';
import { publish, signInState, type SignInDeps, type SignInError } from './deps.ts';
import { endSessions, lockedMinutes, recordFailure, startSession, userView } from './helpers.ts';

export interface ChangePasswordInput {
  readonly username: string;
  readonly currentPassword?: string | undefined;
  readonly newPassword: string;
}

/**
 * Replace an expired or temporary password, or change it by choice, and sign in. The current
 * password is always needed: nobody can choose the first password of an account that has none.
 */
export class ChangePassword {
  readonly #deps: SignInDeps;

  constructor(deps: SignInDeps) {
    this.#deps = deps;
  }

  async execute(input: ChangePasswordInput): Promise<Result<{ readonly user: AuthUser; readonly sessionToken: string }, SignInError>> {
    const deps = this.#deps;
    const username = checkTypedUsername(input.username);
    if (!username.ok) return username;
    for (const typed of [input.currentPassword ?? '', input.newPassword]) {
      const presented = checkPresentedPassword(typed);
      if (!presented.ok) return presented;
    }
    const { enabled } = await signInState(deps);
    if (!enabled) return err({ code: 'SIGN_IN_OFF' });
    const minutes = await lockedMinutes(deps, username.value);
    if (minutes > 0) return err({ code: 'SIGN_IN_LOCKED', minutes });

    const key = lockoutKey(username.value);
    const member = memberForUsername(await deps.team.all(), username.value);
    const before = member ? (await deps.accounts.get(member.id)).passwordHash : null;
    if (!member || !before) {
      await deps.hasher.verifyNothing(input.currentPassword ?? '');
      await recordFailure(deps, key);
      return err({ code: 'INVALID_CREDENTIALS' });
    }
    const allowed = checkNewPassword(input.newPassword, member.username);
    if (!allowed.ok) return allowed;
    if (!input.currentPassword || !(await deps.hasher.verify(input.currentPassword, before))) {
      await recordFailure(deps, key);
      return err({ code: 'WRONG_CURRENT_PASSWORD' });
    }
    if (await deps.hasher.verify(input.newPassword, before)) return err({ code: 'PASSWORD_UNCHANGED' });
    const hash = await deps.hasher.hash(input.newPassword);
    const saved = await deps.signInWrites.run(async (): Promise<Result<{ account: Account; sessionToken: string }, SignInError>> => {
      // Another request may have changed the password while this one was hashing.
      const account = await deps.accounts.get(member.id);
      if (account.passwordHash !== before) return err({ code: 'PASSWORD_CHANGED_MEANWHILE' });
      account.setPassword(hash, deps.clock.now(), false);
      await deps.accounts.save(account);
      await deps.failedAttempts.delete(key);
      await endSessions(deps, member.id);
      const sessionToken = await startSession(deps, member.id);
      return ok({ account, sessionToken });
    });
    if (!saved.ok) return saved;
    const { account, sessionToken } = saved.value;
    await publish(deps, account);
    return ok({ user: userView(member, account, (await signInState(deps)).settings), sessionToken });
  }
}
