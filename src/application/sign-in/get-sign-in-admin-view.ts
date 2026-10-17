import { ok, type Result } from '#shared/result.ts';
import { requireAdmin, type AccessError } from '../access.ts';
import type { Caller } from '../caller.ts';
import type { AuthAdminView } from '../contracts/auth.ts';
import type { SignInDeps } from './deps.ts';
import { adminView } from './helpers.ts';

export class GetSignInAdminView {
  readonly #deps: SignInDeps;

  constructor(deps: SignInDeps) {
    this.#deps = deps;
  }

  async execute(input: { readonly caller: Caller }): Promise<Result<AuthAdminView, AccessError>> {
    const access = requireAdmin(input.caller);
    if (!access.ok) return access;
    return ok(await adminView(this.#deps));
  }
}
