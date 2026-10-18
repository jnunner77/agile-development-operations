import { callerFor, type Caller } from '../caller.ts';
import type { AppDeps } from '../deps.ts';
import type { Identity } from './identity.ts';

export interface ResolveCallerInput {
  readonly identity: Identity;
  /** Who the browser says it acts as (X-User, decoded), after the sign-in gate; null if nobody. */
  readonly actingAs: string | null;
  readonly origin: string | undefined;
}

/** The caller a request's changes are attributed to, looked up against the team as it is now. */
export class ResolveCaller {
  readonly #deps: Pick<AppDeps, 'team'>;

  constructor(deps: Pick<AppDeps, 'team'>) {
    this.#deps = deps;
  }

  async execute(input: ResolveCallerInput): Promise<Caller> {
    return callerFor({ ...input, team: await this.#deps.team.all() });
  }
}
