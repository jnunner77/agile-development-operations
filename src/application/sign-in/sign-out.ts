import type { SignInDeps } from './deps.ts';

export class SignOut {
  readonly #deps: SignInDeps;

  constructor(deps: SignInDeps) {
    this.#deps = deps;
  }

  async execute(input: { readonly sessionToken: string | undefined }): Promise<void> {
    if (input.sessionToken) await this.#deps.sessions.delete(input.sessionToken);
  }
}
