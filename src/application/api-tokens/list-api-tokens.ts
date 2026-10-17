import type { ApiTokenInfo } from '#domain/api-tokens/api-token.ts';
import type { Caller } from '../caller.ts';
import type { SignInDeps } from '../sign-in/deps.ts';
import { forgetStaleTokens, managesAllTokens } from './rules.ts';

/** Administrators (and everyone, with sign-in off) see every token; others see their own. */
export class ListApiTokens {
  readonly #deps: SignInDeps;

  constructor(deps: SignInDeps) {
    this.#deps = deps;
  }

  async execute(input: { readonly caller: Caller }): Promise<ApiTokenInfo[]> {
    await forgetStaleTokens(this.#deps);
    const now = this.#deps.clock.now();
    const all = managesAllTokens(input.caller);
    return (await this.#deps.apiTokens.all()).filter((t) => all || t.memberId === input.caller.memberId).map((t) => t.toInfo(now));
  }
}
