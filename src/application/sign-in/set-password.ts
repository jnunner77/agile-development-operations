import { lockoutKey } from '#domain/sign-in/lockout.ts';
import { checkNewPassword, checkPresentedPassword } from '#domain/sign-in/password.ts';
import { err, ok, type Result } from '#shared/result.ts';
import { requireAdmin } from '../access.ts';
import type { Caller } from '../caller.ts';
import type { AuthAdminView } from '../contracts/auth.ts';
import { publish, type SignInDeps, type SignInError } from './deps.ts';
import { adminView, endSessions, revokeTokens } from './helpers.ts';
import { findTeamMember } from './team.ts';

export interface SetPasswordInput {
  readonly caller: Caller;
  readonly memberId: string;
  readonly password: string;
  /** A temporary password, to be changed at the next sign-in. Default: yes. */
  readonly mustChange?: boolean | undefined;
}

/**
 * An administrator sets someone's password. It is also how a compromised account is taken back,
 * so it ends everything that acts as them: sessions and API tokens.
 */
export class SetPassword {
  readonly #deps: SignInDeps;

  constructor(deps: SignInDeps) {
    this.#deps = deps;
  }

  async execute(input: SetPasswordInput): Promise<Result<AuthAdminView, SignInError>> {
    const access = requireAdmin(input.caller);
    if (!access.ok) return access;
    const presented = checkPresentedPassword(input.password);
    if (!presented.ok) return presented;
    const deps = this.#deps;
    const member = await findTeamMember(deps, input.memberId);
    if (!member.ok) return member;
    const { username, name } = member.value;
    if (!username) return err({ code: 'USERNAME_MISSING', name });
    const allowed = checkNewPassword(input.password, username);
    if (!allowed.ok) return allowed;

    const hash = await deps.hasher.hash(input.password);
    const account = await deps.accounts.get(input.memberId);
    account.setPassword(hash, deps.clock.now(), input.mustChange ?? true);
    await deps.accounts.save(account);
    await deps.failedAttempts.delete(lockoutKey(username));
    await endSessions(deps, input.memberId);
    await revokeTokens(deps, input.memberId);
    await publish(deps, account);
    return ok(await adminView(deps));
  }
}
