import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ApiToken, ApiTokenDraft, checkTokenLimit, displayPrefix, looksLikeApiToken } from '#domain/api-tokens/api-token.ts';
import { Account } from '#domain/sign-in/account.ts';
import { accountsByMember, hasUsableAdmin } from '#domain/sign-in/admins.ts';
import { afterFailure, isForgotten, lockoutKey, minutesLocked } from '#domain/sign-in/lockout.ts';
import { checkNewPassword, checkPresentedPassword } from '#domain/sign-in/password.ts';
import { isSessionLive, sessionsToEnd, type Session } from '#domain/sign-in/session.ts';
import { SignInSettings, SignInSettingsChanges } from '#domain/sign-in/settings.ts';
import type { Member } from '#domain/types.ts';
import { NOW } from './fixtures.ts';

const at = (ms: number) => new Date(NOW.getTime() + ms);
const MIN = 60_000;
const DAY = 86_400_000;

describe('sign-in settings', () => {
  it('default to off and validate their limits', () => {
    assert.deepEqual(SignInSettings.reconstitute(undefined).toSnapshot(), { enabled: false, passwordExpiryDays: 60, sessionTimeoutMinutes: 60 });
    assert.deepEqual(SignInSettingsChanges.validate({ sessionTimeoutMinutes: 1 }), {
      ok: false,
      error: { code: 'NUMBER_OUT_OF_RANGE', field: 'sessionTimeoutMinutes', min: 5, max: 10080 },
    });
    assert.deepEqual(SignInSettingsChanges.validate({ passwordExpiryDays: 1.5 }), { ok: false, error: { code: 'NOT_AN_INTEGER', field: 'passwordExpiryDays' } });
  });

  it('can only be turned on while an administrator can sign in', () => {
    const settings = SignInSettings.reconstitute({});
    const on = SignInSettingsChanges.validate({ enabled: true });
    assert.ok(on.ok);
    assert.deepEqual(settings.update(on.value, false, NOW), { ok: false, error: { code: 'SIGN_IN_NEEDS_ADMIN' } });
    assert.equal(settings.enabled, false);
    assert.ok(settings.update(on.value, true, NOW).ok);
    assert.equal(settings.enabled, true);
  });
});

describe('passwords', () => {
  it('are at least 8 characters, at most 256, and not the username', () => {
    assert.deepEqual(checkNewPassword('short', 'ada'), { ok: false, error: { code: 'PASSWORD_TOO_SHORT', min: 8 } });
    assert.deepEqual(checkNewPassword('x'.repeat(257), 'ada'), { ok: false, error: { code: 'PASSWORD_TOO_LONG', max: 256 } });
    assert.deepEqual(checkNewPassword('Ada.Lovelace', 'ada.lovelace'), { ok: false, error: { code: 'PASSWORD_IS_USERNAME' } });
    assert.ok(checkNewPassword('correct horse', 'ada').ok);
    assert.ok(checkPresentedPassword('').ok);
  });
});

describe('accounts', () => {
  it('expire passwords and refuse sessions while a password is temporary or expired', () => {
    const account = Account.blank('m1');
    assert.equal(account.canHoldSession(NOW, 60), false);
    account.setPassword('hash', NOW, true);
    assert.equal(account.canHoldSession(NOW, 60), false);
    account.setPassword('hash2', NOW, false);
    assert.equal(account.canHoldSession(at(59 * DAY), 60), true);
    assert.equal(account.isExpired(at(60 * DAY), 60), true);
    assert.equal(account.expiresAt(0), null);
    account.clearPassword(NOW);
    assert.equal(account.hasPassword, false);
    assert.deepEqual(
      account.pullEvents().map((e) => e.type),
      ['PasswordSet', 'PasswordSet', 'PasswordCleared'],
    );
  });

  it('count as a usable administrator only when active, named and with a password', () => {
    const member = (id: string, extra: Partial<Member> = {}): Member => ({ id, name: id, username: id, email: '', color: '#000000', active: true, ...extra });
    const admin = Account.blank('a');
    admin.setAdmin(true, NOW);
    admin.setPassword('h', NOW, false);
    const accounts = accountsByMember([admin]);
    assert.equal(hasUsableAdmin([member('a')], accounts), true);
    assert.equal(hasUsableAdmin([member('a', { active: false })], accounts), false);
    assert.equal(hasUsableAdmin([member('a', { username: '' })], accounts), false);
    assert.equal(hasUsableAdmin([member('b')], accounts), false);
  });
});

describe('lockout', () => {
  it('locks a username for five minutes after five failures', () => {
    let record = afterFailure(undefined, NOW);
    for (let i = 1; i < 4; i++) record = afterFailure(record, at(i * 1000));
    assert.equal(minutesLocked(record, at(5000)), 0);
    record = afterFailure(record, at(5000));
    assert.equal(minutesLocked(record, at(5000)), 5);
    assert.equal(minutesLocked(record, at(5000 + 4 * MIN + 1)), 1);
    assert.equal(minutesLocked(record, at(5000 + 5 * MIN)), 0);
  });

  it('forgets failures after a quiet quarter of an hour', () => {
    let record = afterFailure(undefined, NOW);
    for (let i = 1; i < 4; i++) record = afterFailure(record, NOW);
    assert.equal(record.count, 4);
    assert.equal(afterFailure(record, at(16 * MIN)).count, 1);
    assert.equal(isForgotten(record, at(14 * MIN)), false);
    assert.equal(isForgotten(record, at(16 * MIN)), true);
    assert.equal(lockoutKey('  Ada '), 'ada');
  });
});

describe('sessions', () => {
  const session = (createdAt: number, lastSeen = createdAt): Session => ({ token: `t${createdAt}`, memberId: 'm1', createdAt, lastSeen });

  it('end after the inactivity timeout or a day, whichever applies', () => {
    const t = NOW.getTime();
    assert.equal(isSessionLive(session(t), at(59 * MIN), 60), true);
    assert.equal(isSessionLive(session(t), at(61 * MIN), 60), false);
    assert.equal(isSessionLive(session(t, t + 24 * 60 * MIN), at(24 * 60 * MIN + 1), 60), false);
    // A timeout longer than a day stretches the maximum age too.
    assert.equal(isSessionLive(session(t, t + 47 * 60 * MIN), at(47 * 60 * MIN), 48 * 60), true);
  });

  it('keep at most twenty per person, dropping the oldest', () => {
    const many = Array.from({ length: 21 }, (_, i) => session(i));
    assert.deepEqual(sessionsToEnd(many).map((s) => s.createdAt), [0, 1]);
    assert.deepEqual(sessionsToEnd(many.slice(0, 5)), []);
  });
});

describe('API tokens', () => {
  const draft = (input: { name: string; scope?: string; expiresInDays?: number }) => {
    const r = ApiTokenDraft.of(input);
    assert.ok(r.ok, JSON.stringify(r));
    return r.value;
  };
  const token = (id: string, memberId = 'm1', days = 90) =>
    ApiToken.create(draft({ name: ` ${id} `, expiresInDays: days }), { id, memberId, secret: 'boards_abcdefghij', digest: `d-${id}`, createdBy: 'Ann', now: NOW });

  it('are read-only for 90 days unless asked otherwise', () => {
    const t = token('t1');
    const info = t.toInfo(NOW);
    assert.deepEqual([info.name, info.scope, info.prefix, info.expiresAt, info.expired], ['t1', 'read', 'boards_abcdef', at(90 * DAY).toISOString(), false]);
    assert.equal('hash' in info, false);
    assert.equal(t.isExpired(at(90 * DAY)), true);
    assert.equal(t.isStale(at(119 * DAY)), false);
    assert.equal(t.isStale(at(120 * DAY)), true);
  });

  it('check names, scopes and lifetimes', () => {
    assert.deepEqual(ApiTokenDraft.of({ name: ' ' }), { ok: false, error: { code: 'TOKEN_NAME_REQUIRED' } });
    assert.deepEqual(ApiTokenDraft.of({ name: 'x', scope: 'admin' }), { ok: false, error: { code: 'UNKNOWN_TOKEN_SCOPE', scope: 'admin' } });
    assert.deepEqual(ApiTokenDraft.of({ name: 'x', expiresInDays: 366 }), {
      ok: false,
      error: { code: 'NUMBER_OUT_OF_RANGE', field: 'expiresInDays', min: 1, max: 365 },
    });
  });

  it('are limited to twenty working ones per member', () => {
    const tokens = Array.from({ length: 20 }, (_, i) => token(`t${i}`));
    assert.deepEqual(checkTokenLimit(tokens, { id: 'm1', name: 'Ann' }, NOW), { ok: false, error: { code: 'TOKEN_LIMIT_REACHED', name: 'Ann', max: 20 } });
    assert.ok(checkTokenLimit(tokens, { id: 'm2', name: 'Bo' }, NOW).ok);
    // Expired ones don't count.
    assert.ok(checkTokenLimit(tokens, { id: 'm1', name: 'Ann' }, at(91 * DAY)).ok);
  });

  it('only look like tokens with the prefix', () => {
    assert.equal(looksLikeApiToken('boards_x'), true);
    assert.equal(looksLikeApiToken('other_x'), false);
    assert.equal(looksLikeApiToken(`boards_${'x'.repeat(200)}`), false);
    assert.equal(displayPrefix('boards_1234567890'), 'boards_123456');
  });
});
