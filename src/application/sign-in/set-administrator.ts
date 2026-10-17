import type { Account } from '#domain/sign-in/account.ts';
import { hasUsableAdmin } from '#domain/sign-in/admins.ts';
import { err, ok, type Result } from '#shared/result.ts';
import { requireAdmin } from '../access.ts';
import type { Caller } from '../caller.ts';
import type { AuthAdminView } from '../contracts/auth.ts';
import { publish, signInState, type SignInDeps, type SignInError } from './deps.ts';
import { adminView } from './helpers.ts';
import { accountsWith, findTeamMember } from './team.ts';

export interface SetAdministratorInput {
  readonly caller: Caller;
  readonly memberId: string;
  readonly isAdmin: boolean;
}

export class SetAdministrator {
  readonly #deps: SignInDeps;

  constructor(deps: SignInDeps) {
    this.#deps = deps;
  }

  async execute(input: SetAdministratorInput): Promise<Result<AuthAdminView, SignInError>> {
    const access = requireAdmin(input.caller);
    if (!access.ok) return access;
    const deps = this.#deps;
    const member = await findTeamMember(deps, input.memberId);
    if (!member.ok) return member;
    const saved = await deps.signInWrites.run(async (): Promise<Result<Account, SignInError>> => {
      const account = await deps.accounts.get(input.memberId);
      account.setAdmin(input.isAdmin, deps.clock.now());
      const { enabled } = await signInState(deps);
      if (enabled && !hasUsableAdmin(await deps.team.all(), await accountsWith(deps, account))) return err({ code: 'ACCOUNT_IS_LAST_ADMIN' });
      await deps.accounts.save(account);
      return ok(account);
    });
    if (!saved.ok) return saved;
    await publish(deps, saved.value);
    return ok(await adminView(deps));
  }
}
