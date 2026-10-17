import type { Caller } from '../caller.ts';
import type { SignInDeps } from '../sign-in/deps.ts';

/** People manage their own tokens; administrators (and everyone, with sign-in off) manage everyone's. */
export const managesAllTokens = (caller: Caller): boolean => caller.admin === 'granted';

/** Tokens that expired long ago are no longer listed or kept. */
export async function forgetStaleTokens(deps: Pick<SignInDeps, 'apiTokens' | 'clock'>): Promise<void> {
  const now = deps.clock.now();
  for (const token of await deps.apiTokens.all()) if (token.isStale(now)) await deps.apiTokens.delete(token.id);
}
