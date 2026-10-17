import assert from 'node:assert/strict';
import http from 'node:http';
import { Socket } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { Caller } from '#application/caller.ts';
import type { Identity } from '#application/sign-in/identity.ts';
import { ok, err } from '#shared/result.ts';
import { clearedSessionCookie, readCookie, sessionCookie } from '#presentation/sign-in/cookies.ts';
import { gate } from '#presentation/sign-in/gate.ts';
import { Authenticator } from '#presentation/sign-in/authenticator.ts';
import { signInRoutes } from '#presentation/sign-in/routes.ts';

/** A real request object carrying these headers. */
function request(headers: http.IncomingHttpHeaders): http.IncomingMessage {
  const req = new http.IncomingMessage(new Socket());
  req.headers = headers;
  return req;
}

const member = { id: 'm1', name: 'Ann', username: 'ann', email: '', color: '#000000', active: true };
const nobody: Identity = { signInEnabled: true, member: null, isAdmin: false, via: 'none', token: null, invalidToken: false };
const token = { id: 't', name: 't', memberId: 'm1', scope: 'read' as const, prefix: 'boards_x', createdAt: '', createdBy: '', expiresAt: '', lastUsedAt: null, expired: false };

describe('the request gate', () => {
  it('needs a session while sign-in is on, except to sign in', () => {
    assert.deepEqual(gate(nobody, 'GET', '/bootstrap'), { kind: 'reject', status: 401, body: { error: 'Please sign in', code: 'signin' } });
    assert.deepEqual(gate(nobody, 'POST', '/AUTH/login'), { kind: 'pass', actAs: null });
    // GitHub signs its deliveries instead.
    assert.deepEqual(gate(nobody, 'POST', '/integrations/github/webhook'), { kind: 'pass', actAs: null });
    assert.deepEqual(gate({ ...nobody, member, via: 'session' }, 'POST', '/workitems'), { kind: 'pass', actAs: 'm1' });
    assert.deepEqual(gate({ ...nobody, signInEnabled: false }, 'POST', '/workitems'), { kind: 'pass', actAs: 'as-sent' });
  });

  it('lets API tokens act as their member, read-only ones only reading', () => {
    const viaToken: Identity = { ...nobody, member, via: 'token', token };
    assert.deepEqual(gate(viaToken, 'GET', '/bootstrap'), { kind: 'pass', actAs: 'm1' });
    assert.deepEqual(gate(viaToken, 'POST', '/workitems'), { kind: 'reject', status: 403, body: { error: 'This API token is read-only' } });
    assert.deepEqual(gate({ ...nobody, signInEnabled: false, via: 'token', invalidToken: true }, 'GET', '/bootstrap'), {
      kind: 'reject',
      status: 401,
      body: { error: 'Invalid or expired API token', code: 'token' },
    });
  });
});

describe('session cookies', () => {
  it('are HttpOnly and SameSite=Strict, and Secure over HTTPS', () => {
    assert.equal(sessionCookie('abc', false), 'boards_session=abc; Path=/; HttpOnly; SameSite=Strict');
    assert.equal(sessionCookie('abc', true), 'boards_session=abc; Path=/; HttpOnly; SameSite=Strict; Secure');
    assert.match(clearedSessionCookie(), /^boards_session=; Path=\/; Expires=Thu, 01 Jan 1970/);
    const req = request({ cookie: 'a=1; boards_session=xyz%3D; b=2' });
    assert.equal(readCookie(req, 'boards_session'), 'xyz=');
    assert.equal(readCookie(request({ cookie: 'boards_session=%E0%A4' }), 'boards_session'), undefined);
  });
});

describe('sign-in routes', () => {
  let identity: Identity = nobody;
  let caller: Caller = { name: 'Ann', memberId: 'm1', mayModerateComments: false, admin: 'granted', origin: undefined };
  let secure = false;
  const calls: string[] = [];
  const view = { settings: { enabled: true, passwordExpiryDays: 60, sessionTimeoutMinutes: 60 }, overridden: false, accounts: [] };
  const status = { enabled: true, overridden: false, user: null, settings: view.settings, passwordMinLength: 8 };
  const routes = signInRoutes({
    context: { caller: () => caller, identity: () => ({ identity, sessionToken: 'old-session' }), secure: () => secure },
    getSignInStatus: { execute: async () => status },
    signIn: {
      execute: async (input) => {
        calls.push(`signIn:${input.username}`);
        return input.password === 'right' ? ok({ result: { status: 'ok' as const, user: { memberId: 'm1', name: 'Ann', username: 'ann', isAdmin: true, passwordExpiresAt: null } }, sessionToken: 'new-session' }) : err({ code: 'INVALID_CREDENTIALS' as const });
      },
    },
    changePassword: { execute: async () => err({ code: 'WRONG_CURRENT_PASSWORD' as const }) },
    signOut: {
      execute: async (input) => {
        calls.push(`signOut:${input.sessionToken}`);
      },
    },
    getSignInAdminView: { execute: async () => ok(view) },
    updateSignInSettings: {
      execute: async () => {
        calls.push('updateSettings');
        return ok(view);
      },
    },
    setAdministrator: { execute: async () => ok(view) },
    setPassword: { execute: async () => ok(view) },
    resetPassword: { execute: async () => ok(view) },
    listApiTokens: { execute: async () => [] },
    createApiToken: { execute: async () => ok({ token: 'boards_new', info: token }) },
    revokeApiToken: { execute: async () => ok(undefined) },
  });

  let server: http.Server;
  let base = '';
  before(async () => {
    server = http.createServer((req, res) => {
      void routes.handle(req, res).then((handled) => {
        if (!handled) res.writeHead(404).end();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    base = `http://127.0.0.1:${address.port}`;
  });
  after(() => server.close());
  beforeEach(() => {
    identity = nobody;
    caller = { ...caller, admin: 'granted' };
    secure = false;
    calls.length = 0;
  });

  const call = (method: string, path: string, body?: unknown) =>
    fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

  it('set a session cookie when signing in, Secure over HTTPS', async () => {
    const wrong = await call('POST', '/auth/login', { username: 'ann', password: 'wrong' });
    assert.deepEqual([wrong.status, await wrong.json(), wrong.headers.get('set-cookie')], [401, { error: 'Incorrect username or password' }, null]);
    secure = true;
    const right = await call('POST', '/auth/login', { username: 'ann', password: 'right' });
    assert.equal(right.status, 200);
    assert.equal(right.headers.get('set-cookie'), 'boards_session=new-session; Path=/; HttpOnly; SameSite=Strict; Secure');
    assert.deepEqual(await right.json(), { status: 'ok', user: { memberId: 'm1', name: 'Ann', username: 'ann', isAdmin: true, passwordExpiresAt: null } });
  });

  it('sign out the session the request carried, clearing the cookie', async () => {
    const res = await call('POST', '/auth/logout');
    assert.equal(res.status, 204);
    assert.match(res.headers.get('set-cookie') ?? '', /^boards_session=;/);
    assert.deepEqual(calls, ['signOut:old-session']);
  });

  it('refuse API tokens everywhere but the status', async () => {
    identity = { ...nobody, member, via: 'token', token };
    for (const [method, path] of [
      ['POST', '/auth/login'],
      ['GET', '/AUTH/Tokens'],
      ['GET', '/auth/admin'],
    ] as const) {
      const res = await call(method, path, method === 'POST' ? { username: 'x', password: 'y' } : undefined);
      assert.deepEqual([res.status, await res.json()], [403, { error: "API tokens can't be used to manage sign-in or tokens" }], `${method} ${path}`);
    }
    assert.equal((await call('GET', '/auth/status')).status, 200);
    assert.deepEqual(calls, []);
  });

  it('turn non-administrators away from administration before reading the request', async () => {
    caller = { ...caller, admin: 'not-admin' };
    const res = await call('PUT', '/auth/settings', { bogus: true });
    assert.deepEqual([res.status, await res.json()], [403, { error: 'Only administrators can do this' }]);
    assert.deepEqual(calls, []);
    caller = { ...caller, admin: 'granted' };
    assert.equal((await call('PUT', '/auth/settings', { bogus: true })).status, 400);
    assert.equal((await call('PUT', '/auth/settings', { enabled: false })).status, 200);
    assert.deepEqual(calls, ['updateSettings']);
  });

  it('create tokens with 201 and revoke them with 204', async () => {
    const created = await call('POST', '/auth/tokens', { name: 'CI' });
    assert.deepEqual([created.status, await created.json()], [201, { token: 'boards_new', info: token }]);
    assert.equal((await call('DELETE', '/auth/tokens/t')).status, 204);
  });
});

describe('the authenticator', () => {
  it('prefers an API token to a session cookie', async () => {
    const seen: unknown[] = [];
    const authenticator = new Authenticator({
      execute: async (input) => {
        seen.push(input);
        return nobody;
      },
    });
    await authenticator.identify(request({ authorization: 'Bearer boards_x', cookie: 'boards_session=s1' }));
    await authenticator.identify(request({ cookie: 'boards_session=s1' }));
    assert.deepEqual(seen, [
      { apiToken: 'boards_x', sessionToken: 's1', touch: true },
      { apiToken: undefined, sessionToken: 's1', touch: true },
    ]);
    assert.equal(await authenticator.stillSignedIn('s1'), false);
  });
});
