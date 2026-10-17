import { err, ok, type Result } from '#shared/result.ts';
import type { Caller } from '../caller.ts';
import { publish, type ApiTokensError, type SignInDeps } from '../sign-in/deps.ts';
import { managesAllTokens } from './rules.ts';

export class RevokeApiToken {
  readonly #deps: SignInDeps;

  constructor(deps: SignInDeps) {
    this.#deps = deps;
  }

  async execute(input: { readonly caller: Caller; readonly id: string }): Promise<Result<void, ApiTokensError>> {
    const token = await this.#deps.apiTokens.findById(input.id);
    if (!token) return err({ code: 'TOKEN_NOT_FOUND', id: input.id });
    if (!managesAllTokens(input.caller) && token.memberId !== input.caller.memberId) return err({ code: 'TOKEN_FOR_SOMEONE_ELSE', action: 'revoke' });
    token.revoke(this.#deps.clock.now());
    await this.#deps.apiTokens.delete(token.id);
    await publish(this.#deps, token);
    return ok(undefined);
  }
}
