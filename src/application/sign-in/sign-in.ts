import { lockoutKey } from '#domain/sign-in/lockout.ts';
import { checkPresentedPassword } from '#domain/sign-in/password.ts';
import { checkTypedUsername, memberForUsername } from '#domain/sign-in/usernames.ts';
import { err, ok, type Result } from '#shared/result.ts';
import type { LoginResult } from '../contracts/auth.ts';
import { signInState, type SignInDeps, type SignInError } from './deps.ts';
import { lockedMinutes, recordFailure, startSession, userView } from './helpers.ts';

export interface SignInInput {
  readonly username: string;
  readonly password: string;
}

export interface SignInOutput {
  readonly result: LoginResult;
  /** The new session's token, when signed in (not when the password must be changed first). */
  readonly sessionToken: string | null;
}

/**
 * Check a username and password. Wrong ones count toward locking the username; an unknown
 * username, or an account without a password, answers exactly like a wrong password.
 */
export class SignIn {
  readonly #deps: SignInDeps;

  constructor(deps: SignInDeps) {
    this.#deps = deps;
  }

  async execute(input: SignInInput): Promise<Result<SignInOutput, SignInError>> {
    const username = checkTypedUsername(input.username);
    if (!username.ok) return username;
    const presented = checkPresentedPassword(input.password);
    if (!presented.ok) return presented;
    const { settings, enabled } = await signInState(this.#deps);
    if (!enabled) return err({ code: 'SIGN_IN_OFF' });
    const minutes = await lockedMinutes(this.#deps, username.value);
    if (minutes > 0) return err({ code: 'SIGN_IN_LOCKED', minutes });

    const key = lockoutKey(username.value);
    const member = memberForUsername(await this.#deps.team.all(), username.value);
    const account = member ? await this.#deps.accounts.get(member.id) : undefined;
    if (!member || !account?.passwordHash) {
      await this.#deps.hasher.verifyNothing(input.password);
      await recordFailure(this.#deps, key);
      return err({ code: 'INVALID_CREDENTIALS' });
    }
    if (!(await this.#deps.hasher.verify(input.password, account.passwordHash))) {
      await recordFailure(this.#deps, key);
      return err({ code: 'INVALID_CREDENTIALS' });
    }
    await this.#deps.failedAttempts.delete(key);
    if (account.mustChange) return ok({ result: { status: 'change', reason: 'temporary' }, sessionToken: null });
    if (account.isExpired(this.#deps.clock.now(), settings.passwordExpiryDays)) return ok({ result: { status: 'change', reason: 'expired' }, sessionToken: null });
    const sessionToken = await startSession(this.#deps, member.id);
    return ok({ result: { status: 'ok', user: userView(member, account, settings) }, sessionToken });
  }
}
