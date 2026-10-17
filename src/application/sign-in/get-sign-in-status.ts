import { PASSWORD_MIN_LENGTH } from '#domain/sign-in/password.ts';
import type { Member } from '#domain/types.ts';
import type { AuthStatus } from '../contracts/auth.ts';
import { signInState, type SignInDeps } from './deps.ts';
import { userView } from './helpers.ts';

export class GetSignInStatus {
  readonly #deps: SignInDeps;

  constructor(deps: SignInDeps) {
    this.#deps = deps;
  }

  async execute(input: { readonly member: Member | null }): Promise<AuthStatus> {
    const { settings, enabled } = await signInState(this.#deps);
    const user = enabled && input.member ? userView(input.member, await this.#deps.accounts.get(input.member.id), settings) : null;
    return { enabled, overridden: this.#deps.signInForcedOff, user, settings: settings.toSnapshot(), passwordMinLength: PASSWORD_MIN_LENGTH };
  }
}
