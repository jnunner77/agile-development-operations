import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { exemptFromRateLimits } from '#application/access.ts';
import { CreateApiToken } from '#application/api-tokens/create-api-token.ts';
import { ListApiTokens } from '#application/api-tokens/list-api-tokens.ts';
import { RevokeApiToken } from '#application/api-tokens/revoke-api-token.ts';
import type { Caller } from '#application/caller.ts';
import { ChangePassword } from '#application/sign-in/change-password.ts';
import { GetSignInAdminView } from '#application/sign-in/get-sign-in-admin-view.ts';
import { GetSignInStatus } from '#application/sign-in/get-sign-in-status.ts';
import { IdentifyCaller } from '#application/sign-in/identify-caller.ts';
import { ResetPassword } from '#application/sign-in/reset-password.ts';
import { SetAdministrator } from '#application/sign-in/set-administrator.ts';
import { SetPassword } from '#application/sign-in/set-password.ts';
import { SignIn } from '#application/sign-in/sign-in.ts';
import { UpdateSignInSettings } from '#application/sign-in/update-sign-in-settings.ts';
import { UpdateMember } from '#application/team/update-member.ts';
import { ann, bo, setup, unwrap } from './fixtures.ts';

const MIN = 60_000;
const DAY = 86_400_000;
const admin: Caller = { ...ann, admin: 'granted' };

/** Ann (m1) is an administrator with a password, sign-in is on, Bo (m2) has a username. */
async function signedInTeam() {
  const t = setup();
  unwrap(await new UpdateMember(t.deps).execute({ caller: admin, id: 'm1', username: 'ann' }));
  unwrap(await new UpdateMember(t.deps).execute({ caller: admin, id: 'm2', username: 'bo' }));
  unwrap(await new SetAdministrator(t.deps).execute({ caller: admin, memberId: 'm1', isAdmin: true }));
  unwrap(await new SetPassword(t.deps).execute({ caller: admin, memberId: 'm1', password: 'correct horse', mustChange: false }));
  unwrap(await new UpdateSignInSettings(t.deps).execute({ caller: admin, enabled: true }));
  return t;
}

describe('signing in', () => {
  it('needs sign-in to be on', async () => {
    const t = setup();
    assert.deepEqual(await new SignIn(t.deps).execute({ username: 'ann', password: 'x' }), { ok: false, error: { code: 'SIGN_IN_OFF' } });
  });

  it('starts a session that identifies the member', async () => {
    const t = await signedInTeam();
    const signedIn = unwrap(await new SignIn(t.deps).execute({ username: ' ANN ', password: 'correct horse' }));
    assert.equal(signedIn.result.status, 'ok');
    assert.ok(signedIn.sessionToken);
    const identity = await new IdentifyCaller(t.deps).execute({ sessionToken: signedIn.sessionToken, touch: true });
    assert.deepEqual([identity.member?.id, identity.via, identity.isAdmin, identity.signInEnabled], ['m1', 'session', true, true]);
    const status = await new GetSignInStatus(t.deps).execute({ member: identity.member });
    assert.equal(status.user?.username, 'ann');
  });

  it('answers an unknown username exactly like a wrong password', async () => {
    const t = await signedInTeam();
    const signIn = new SignIn(t.deps);
    assert.deepEqual(await signIn.execute({ username: 'nobody', password: 'x' }), { ok: false, error: { code: 'INVALID_CREDENTIALS' } });
    assert.deepEqual(await signIn.execute({ username: 'bo', password: 'x' }), { ok: false, error: { code: 'INVALID_CREDENTIALS' } });
    assert.deepEqual(await signIn.execute({ username: 'ann', password: 'wrong' }), { ok: false, error: { code: 'INVALID_CREDENTIALS' } });
    assert.deepEqual(await signIn.execute({ username: '  ', password: 'x' }), { ok: false, error: { code: 'USERNAME_REQUIRED' } });
  });

  it('locks a username for five minutes after five failures, even for the right password', async () => {
    const t = await signedInTeam();
    const signIn = new SignIn(t.deps);
    for (let i = 0; i < 5; i++) await signIn.execute({ username: 'ann', password: 'wrong' });
    assert.deepEqual(await signIn.execute({ username: 'ann', password: 'correct horse' }), { ok: false, error: { code: 'SIGN_IN_LOCKED', minutes: 5 } });
    t.clock.at += 5 * MIN;
    assert.ok((await signIn.execute({ username: 'ann', password: 'correct horse' })).ok);
  });

  it('counts simultaneous failed attempts without losing increments', async () => {
    const t = await signedInTeam();
    const signIn = new SignIn(t.deps);
    await Promise.all(Array.from({ length: 5 }, () => signIn.execute({ username: 'ann', password: 'wrong' })));
    assert.deepEqual(await signIn.execute({ username: 'ann', password: 'correct horse' }), {
      ok: false,
      error: { code: 'SIGN_IN_LOCKED', minutes: 5 },
    });
  });

  it('asks for a new password when it is temporary or expired, without a session', async () => {
    const t = await signedInTeam();
    unwrap(await new SetPassword(t.deps).execute({ caller: admin, memberId: 'm2', password: 'temporary1' }));
    assert.deepEqual(unwrap(await new SignIn(t.deps).execute({ username: 'bo', password: 'temporary1' })), {
      result: { status: 'change', reason: 'temporary' },
      sessionToken: null,
    });
    t.clock.at += 61 * DAY;
    assert.deepEqual(unwrap(await new SignIn(t.deps).execute({ username: 'ann', password: 'correct horse' })).result, { status: 'change', reason: 'expired' });
  });
});

describe('changing a password', () => {
  it('needs the current one, a different new one, and signs in everywhere afresh', async () => {
    const t = await signedInTeam();
    const old = unwrap(await new SignIn(t.deps).execute({ username: 'ann', password: 'correct horse' })).sessionToken;
    const change = new ChangePassword(t.deps);
    assert.deepEqual(await change.execute({ username: 'ann', currentPassword: 'wrong', newPassword: 'battery staple' }), {
      ok: false,
      error: { code: 'WRONG_CURRENT_PASSWORD' },
    });
    assert.deepEqual(await change.execute({ username: 'ann', currentPassword: 'correct horse', newPassword: 'correct horse' }), {
      ok: false,
      error: { code: 'PASSWORD_UNCHANGED' },
    });
    assert.deepEqual(await change.execute({ username: 'ann', currentPassword: 'correct horse', newPassword: 'ann' }), {
      ok: false,
      error: { code: 'PASSWORD_TOO_SHORT', min: 8 },
    });
    const changed = unwrap(await change.execute({ username: 'ann', currentPassword: 'correct horse', newPassword: 'battery staple' }));
    assert.equal(changed.user.memberId, 'm1');
    const identify = new IdentifyCaller(t.deps);
    assert.equal((await identify.execute({ sessionToken: old ?? '', touch: false })).member, null);
    assert.equal((await identify.execute({ sessionToken: changed.sessionToken, touch: false })).member?.id, 'm1');
  });

  it('keeps password change and session issuance in one serialized operation', async () => {
    const t = await signedInTeam();
    let markSaveStarted: () => void = () => {};
    let releaseSave: () => void = () => {};
    const saveStarted = new Promise<void>((resolve) => (markSaveStarted = resolve));
    const saveRelease = new Promise<void>((resolve) => (releaseSave = resolve));
    const sessions = t.deps.sessions;
    const save = sessions.save.bind(sessions);
    let holdSave = true;
    sessions.save = async (session) => {
      await save(session);
      if (holdSave) {
        holdSave = false;
        markSaveStarted();
        await saveRelease;
      }
    };

    const changing = new ChangePassword(t.deps).execute({ username: 'ann', currentPassword: 'correct horse', newPassword: 'battery staple' });
    await saveStarted;
    let resetFinished = false;
    const resetting = new SetPassword(t.deps).execute({ caller: admin, memberId: 'm1', password: 'new admin password', mustChange: false }).then((result) => {
      resetFinished = true;
      return result;
    });
    await Promise.resolve();
    assert.equal(resetFinished, false);
    releaseSave();
    const changed = unwrap(await changing);
    unwrap(await resetting);
    assert.equal((await new IdentifyCaller(t.deps).execute({ sessionToken: changed.sessionToken, touch: false })).member, null);
  });
});

describe('sessions', () => {
  it('end after the inactivity timeout, and stay alive while used', async () => {
    const t = await signedInTeam();
    const token = unwrap(await new SignIn(t.deps).execute({ username: 'ann', password: 'correct horse' })).sessionToken ?? '';
    const identify = new IdentifyCaller(t.deps);
    t.clock.at += 50 * MIN;
    assert.ok((await identify.execute({ sessionToken: token, touch: true })).member);
    t.clock.at += 50 * MIN;
    assert.ok((await identify.execute({ sessionToken: token, touch: false })).member);
    t.clock.at += 11 * MIN;
    assert.equal((await identify.execute({ sessionToken: token, touch: true })).member, null);
  });

  it('keeps concurrent sign-ins within the per-member session limit', async () => {
    const t = await signedInTeam();
    const signIn = new SignIn(t.deps);
    await Promise.all(Array.from({ length: 25 }, () => signIn.execute({ username: 'ann', password: 'correct horse' })));
    assert.equal((await t.deps.sessions.forMember('m1')).length, 20);
  });
});

describe('administration', () => {
  it('keeps an administrator who can sign in while sign-in is on', async () => {
    const t = await signedInTeam();
    assert.deepEqual(await new SetAdministrator(t.deps).execute({ caller: admin, memberId: 'm1', isAdmin: false }), {
      ok: false,
      error: { code: 'ACCOUNT_IS_LAST_ADMIN' },
    });
    assert.deepEqual(await new ResetPassword(t.deps).execute({ caller: admin, memberId: 'm1' }), { ok: false, error: { code: 'ACCOUNT_IS_LAST_ADMIN' } });
    assert.equal((await t.accounts.get('m1')).isAdmin, true);
  });

  it('can only turn sign-in on once an administrator has a password', async () => {
    const t = setup();
    assert.deepEqual(await new UpdateSignInSettings(t.deps).execute({ caller: admin, enabled: true }), { ok: false, error: { code: 'SIGN_IN_NEEDS_ADMIN' } });
    assert.deepEqual(await new UpdateSignInSettings(t.deps).execute({ caller: bo, enabled: false }), { ok: false, error: { code: 'ADMIN_ONLY', reason: 'not-admin' } });
  });

  it('needs a username before setting a password, and never shows hashes', async () => {
    const t = setup();
    assert.deepEqual(await new SetPassword(t.deps).execute({ caller: admin, memberId: 'm3', password: 'correct horse' }), {
      ok: false,
      error: { code: 'USERNAME_MISSING', name: 'Admin' },
    });
    const t2 = await signedInTeam();
    const view = unwrap(await new GetSignInAdminView(t2.deps).execute({ caller: admin }));
    const ann = view.accounts.find((a) => a.memberId === 'm1');
    assert.deepEqual([ann?.isAdmin, ann?.hasPassword, ann?.mustChange], [true, true, false]);
    assert.equal(JSON.stringify(view).includes('hashed:'), false);
  });

  it('ends sessions and revokes tokens when an administrator sets a password', async () => {
    const t = await signedInTeam();
    const bob: Caller = { ...bo, memberId: 'm2', admin: 'not-admin' };
    unwrap(await new SetPassword(t.deps).execute({ caller: admin, memberId: 'm2', password: 'bo password', mustChange: false }));
    const session = unwrap(await new SignIn(t.deps).execute({ username: 'bo', password: 'bo password' })).sessionToken ?? '';
    const secret = unwrap(await new CreateApiToken(t.deps).execute({ caller: bob, name: 'script' })).token;
    unwrap(await new SetPassword(t.deps).execute({ caller: admin, memberId: 'm2', password: 'new password' }));
    const identify = new IdentifyCaller(t.deps);
    assert.equal((await identify.execute({ sessionToken: session, touch: false })).member, null);
    assert.equal((await identify.execute({ apiToken: secret, touch: false })).invalidToken, true);
  });
});

describe('API tokens', () => {
  it('act as their member, are shown once, and can be revoked', async () => {
    const t = await signedInTeam();
    const created = unwrap(await new CreateApiToken(t.deps).execute({ caller: admin, name: 'CI', scope: 'write' }));
    assert.match(created.token, /^boards_/);
    assert.equal(t.apiTokens.rows()[0]?.hash, `digest:${created.token}`);
    const identity = await new IdentifyCaller(t.deps).execute({ apiToken: created.token, touch: true });
    assert.deepEqual([identity.via, identity.member?.id, identity.token?.scope], ['token', 'm1', 'write']);
    assert.ok(t.apiTokens.rows()[0]?.lastUsedAt);
    unwrap(await new RevokeApiToken(t.deps).execute({ caller: admin, id: created.info.id }));
    assert.equal((await new IdentifyCaller(t.deps).execute({ apiToken: created.token, touch: true })).invalidToken, true);
  });

  it('are managed by their member, or by administrators for anyone', async () => {
    const t = await signedInTeam();
    const bob: Caller = { ...bo, memberId: 'm2', admin: 'not-admin' };
    assert.deepEqual(await new CreateApiToken(t.deps).execute({ caller: bob, name: 'x', memberId: 'm1' }), {
      ok: false,
      error: { code: 'TOKEN_FOR_SOMEONE_ELSE', action: 'create' },
    });
    const annToken = unwrap(await new CreateApiToken(t.deps).execute({ caller: admin, name: 'for Bo', memberId: 'm2' }));
    unwrap(await new CreateApiToken(t.deps).execute({ caller: admin, name: 'mine' }));
    assert.deepEqual((await new ListApiTokens(t.deps).execute({ caller: bob })).map((x) => x.name), ['for Bo']);
    assert.equal((await new ListApiTokens(t.deps).execute({ caller: admin })).length, 2);
    const mine = (await new ListApiTokens(t.deps).execute({ caller: admin })).find((x) => x.name === 'mine');
    assert.deepEqual(await new RevokeApiToken(t.deps).execute({ caller: bob, id: mine?.id ?? '' }), {
      ok: false,
      error: { code: 'TOKEN_FOR_SOMEONE_ELSE', action: 'revoke' },
    });
    unwrap(await new RevokeApiToken(t.deps).execute({ caller: bob, id: annToken.info.id }));
  });

  it('stop working when they expire, and are forgotten a month later', async () => {
    const t = await signedInTeam();
    const created = unwrap(await new CreateApiToken(t.deps).execute({ caller: admin, name: 'short', expiresInDays: 1 }));
    t.clock.at += DAY;
    assert.equal((await new IdentifyCaller(t.deps).execute({ apiToken: created.token, touch: true })).invalidToken, true);
    assert.equal((await new ListApiTokens(t.deps).execute({ caller: admin }))[0]?.expired, true);
    t.clock.at += 30 * DAY;
    assert.deepEqual(await new ListApiTokens(t.deps).execute({ caller: admin }), []);
  });

  it('record the caller’s member as creator, never a name the browser made up', async () => {
    const t = await signedInTeam();
    const created = unwrap(await new CreateApiToken(t.deps).execute({ caller: { ...admin, name: 'Totally The Admin' }, name: 'x' }));
    assert.equal(created.info.createdBy, 'Ann');
    const anonymous = unwrap(await new CreateApiToken(t.deps).execute({ caller: { ...admin, name: 'Someone', memberId: null }, name: 'y', memberId: 'm1' }));
    assert.equal(anonymous.info.createdBy, 'Anonymous');
  });

  it('can only be created for active members', async () => {
    const t = await signedInTeam();
    unwrap(await new UpdateMember(t.deps).execute({ caller: admin, id: 'm2', active: false }));
    assert.deepEqual(await new CreateApiToken(t.deps).execute({ caller: admin, name: 'x', memberId: 'm2' }), {
      ok: false,
      error: { code: 'TOKEN_MEMBER_INACTIVE', name: 'Bo' },
    });
  });
});

describe('exemption from rate limits', () => {
  const base = { signInEnabled: true, member: { id: 'm1', name: 'Ann', username: 'ann', email: '', color: '#0078d4', active: true }, isAdmin: true, via: 'session', token: null, invalidToken: false } as const;

  it('covers only an administrator signed in with a session while sign-in is on', () => {
    assert.equal(exemptFromRateLimits(base), true);
    assert.equal(exemptFromRateLimits({ ...base, isAdmin: false }), false);
    assert.equal(exemptFromRateLimits({ ...base, via: 'token' }), false);
    assert.equal(exemptFromRateLimits({ ...base, signInEnabled: false }), false);
    assert.equal(exemptFromRateLimits({ ...base, via: 'none', member: null }), false);
  });
});
