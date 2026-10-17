import type { Caller } from '../caller.ts';
import type { SignInDeps } from '../sign-in/deps.ts';

/** People manage their own tokens; administrators (and everyone, with sign-in off) manage everyone's. */
export const managesAllTokens = (caller: Caller): boolean => caller.admin === 'granted';

/** Tokens that expired long ago are no longer listed or kept. */
export async function forgetStaleTokens(deps: Pick<SignInDeps, 'apiTokens' | 'clock'>): Promise<void> {
  const now = deps.clock.now();
  const stale = (await deps.apiTokens.all()).filter((t) => t.isStale(now)).map((t) => t.id);
  if (stale.length) await deps.apiTokens.deleteMany(stale);
}
