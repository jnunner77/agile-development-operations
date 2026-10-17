import { ok } from '#shared/result.ts';
import { boolean, number, object, optional, required, string, type Parsed } from '../http/parse.ts';

export function parseLogin(value: unknown): Parsed<{ readonly username: string; readonly password: string }> {
  const body = object(value, ['username', 'password']);
  if (!body.ok) return body;
  const username = required(body.value, 'username', string);
  if (!username.ok) return username;
  const password = optional(body.value, 'password', string);
  if (!password.ok) return password;
  return ok({ username: username.value, password: password.value ?? '' });
}

export function parsePasswordChange(value: unknown): Parsed<{ readonly username: string; readonly currentPassword: string | undefined; readonly newPassword: string }> {
  const body = object(value, ['username', 'currentPassword', 'newPassword']);
  if (!body.ok) return body;
  const username = required(body.value, 'username', string);
  if (!username.ok) return username;
  const currentPassword = optional(body.value, 'currentPassword', string);
  if (!currentPassword.ok) return currentPassword;
  const newPassword = required(body.value, 'newPassword', string);
  if (!newPassword.ok) return newPassword;
  return ok({ username: username.value, currentPassword: currentPassword.value, newPassword: newPassword.value });
}

export function parseSignInSettings(
  value: unknown,
): Parsed<{ readonly enabled: boolean | undefined; readonly passwordExpiryDays: number | undefined; readonly sessionTimeoutMinutes: number | undefined }> {
  const body = object(value, ['enabled', 'passwordExpiryDays', 'sessionTimeoutMinutes']);
  if (!body.ok) return body;
  const enabled = optional(body.value, 'enabled', boolean);
  if (!enabled.ok) return enabled;
  const passwordExpiryDays = optional(body.value, 'passwordExpiryDays', number);
  if (!passwordExpiryDays.ok) return passwordExpiryDays;
  const sessionTimeoutMinutes = optional(body.value, 'sessionTimeoutMinutes', number);
  if (!sessionTimeoutMinutes.ok) return sessionTimeoutMinutes;
  return ok({ enabled: enabled.value, passwordExpiryDays: passwordExpiryDays.value, sessionTimeoutMinutes: sessionTimeoutMinutes.value });
}

export function parseAdministrator(value: unknown): Parsed<{ readonly isAdmin: boolean }> {
  const body = object(value, ['isAdmin']);
  if (!body.ok) return body;
  const isAdmin = required(body.value, 'isAdmin', boolean);
  return isAdmin.ok ? ok({ isAdmin: isAdmin.value }) : isAdmin;
}

export function parseSetPassword(value: unknown): Parsed<{ readonly password: string; readonly mustChange: boolean | undefined }> {
  const body = object(value, ['password', 'mustChange']);
  if (!body.ok) return body;
  const password = required(body.value, 'password', string);
  if (!password.ok) return password;
  const mustChange = optional(body.value, 'mustChange', boolean);
  if (!mustChange.ok) return mustChange;
  return ok({ password: password.value, mustChange: mustChange.value });
}

export function parseNewToken(
  value: unknown,
): Parsed<{ readonly name: string; readonly memberId: string | undefined; readonly scope: string | undefined; readonly expiresInDays: number | undefined }> {
  const body = object(value, ['name', 'memberId', 'scope', 'expiresInDays']);
  if (!body.ok) return body;
  const name = required(body.value, 'name', string);
  if (!name.ok) return name;
  const memberId = optional(body.value, 'memberId', string);
  if (!memberId.ok) return memberId;
  const scope = optional(body.value, 'scope', string);
  if (!scope.ok) return scope;
  const expiresInDays = optional(body.value, 'expiresInDays', number);
  if (!expiresInDays.ok) return expiresInDays;
  return ok({ name: name.value, memberId: memberId.value, scope: scope.value, expiresInDays: expiresInDays.value });
}
