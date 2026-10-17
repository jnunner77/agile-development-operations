import { err, ok, type Result } from '#shared/result.ts';

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 256;

export type PasswordError =
  | { readonly code: 'PASSWORD_TOO_SHORT'; readonly min: number }
  | { readonly code: 'PASSWORD_TOO_LONG'; readonly max: number }
  | { readonly code: 'PASSWORD_IS_USERNAME' };

/** Any password someone types is limited in length, so hashing it stays cheap. */
export function checkPresentedPassword(password: string): Result<void, PasswordError> {
  return password.length > PASSWORD_MAX_LENGTH ? err({ code: 'PASSWORD_TOO_LONG', max: PASSWORD_MAX_LENGTH }) : ok(undefined);
}

/** A new password is long enough and isn't the username. */
export function checkNewPassword(password: string, username: string): Result<void, PasswordError> {
  const presented = checkPresentedPassword(password);
  if (!presented.ok) return presented;
  if (password.length < PASSWORD_MIN_LENGTH) return err({ code: 'PASSWORD_TOO_SHORT', min: PASSWORD_MIN_LENGTH });
  if (username && password.toLowerCase() === username.toLowerCase()) return err({ code: 'PASSWORD_IS_USERNAME' });
  return ok(undefined);
}
