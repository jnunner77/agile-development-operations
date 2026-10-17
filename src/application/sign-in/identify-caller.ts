import type { SignInDeps } from './deps.ts';
import { signInState } from './deps.ts';
import { memberForApiToken, memberForSession } from './helpers.ts';
import type { Identity } from './identity.ts';

export interface IdentifyCallerInput {
  /** The session cookie, if any. */
  readonly sessionToken?: string | undefined;
  /** An API token from the Authorization header, if any. It wins over a session. */
  readonly apiToken?: string | undefined;
  /** Count the request as activity, keeping the session alive. */
  readonly touch: boolean;
}

/** Work out who a request comes from. It rejects no one; the caller decides what to allow. */
export class IdentifyCaller {
  readonly #deps: SignInDeps;

  constructor(deps: SignInDeps) {
    this.#deps = deps;
  }

  async execute(input: IdentifyCallerInput): Promise<Identity> {
    const { enabled } = await signInState(this.#deps);
    const isAdmin = async (memberId: string) => (await this.#deps.accounts.get(memberId)).isAdmin;
    if (input.apiToken !== undefined) {
      const found = await memberForApiToken(this.#deps, input.apiToken);
      if (!found) return { signInEnabled: enabled, member: null, isAdmin: false, via: 'token', token: null, invalidToken: true };
      return { signInEnabled: enabled, member: found.member, isAdmin: await isAdmin(found.member.id), via: 'token', token: found.token, invalidToken: false };
    }
    const member = input.sessionToken ? await memberForSession(this.#deps, input.sessionToken, input.touch) : null;
    if (!member) return { signInEnabled: enabled, member: null, isAdmin: false, via: 'none', token: null, invalidToken: false };
    return { signInEnabled: enabled, member, isAdmin: await isAdmin(member.id), via: 'session', token: null, invalidToken: false };
  }
}
