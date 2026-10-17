import { err, ok, type Result } from '#shared/result.ts';
import type { Caller } from './caller.ts';

export type AccessError = { readonly code: 'ADMIN_ONLY'; readonly reason: 'token' | 'not-admin' };

export function requireAdmin(caller: Caller): Result<void, AccessError> {
  return caller.admin === 'granted' ? ok(undefined) : err({ code: 'ADMIN_ONLY', reason: caller.admin });
}
