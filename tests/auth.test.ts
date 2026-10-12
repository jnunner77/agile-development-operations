import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../server/app';
import { AuthManager } from '../server/auth';
import { emptyDatabase } from '../server/schema';
import { SnapshotManager } from '../server/snapshots';
import { Store } from '../server/store';

const DAY = 86_400_000;

let dir: string;
let store: Store;
let auth: AuthManager;
let app: ReturnType<typeof createApp>;
let clock: number;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boards-auth-'));
  store = new Store(dir, () => emptyDatabase());
  clock = Date.parse('2026-01-01T09:00:00Z');
  auth = new AuthManager(store, { now: () => clock });
  // Rate limits are covered in security.test.ts; these tests make many attempts from one IP.
  app = createApp({ store, snapshots: new SnapshotManager(store), auth, security: false });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

async function member(name: string, username: string) {
  const res = await request(app).post('/api/members').send({ name, username });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.result as { id: string };
}

/** Set a member's password as an administrator would (the API is open while sign-in is off). */
async function setPassword(id: string, password = 'correct horse', mustChange = false, agent?: request.Agent) {
  const res = await (agent ?? request(app)).post(`/api/auth/accounts/${id}/password`).send({ password, mustChange });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

/** Create an admin and a regular user with passwords ("correct horse"), then turn sign-in on. */
async function setup() {
  const ada = await member('Ada Admin', 'ada');
  const bo = await member('Bo User', 'bo');
  expect((await request(app).patch(`/api/auth/accounts/${ada.id}`).send({ isAdmin: true })).status).toBe(200);
  await setPassword(ada.id);
  await setPassword(bo.id);
  expect((await request(app).put('/api/auth/settings').send({ enabled: true })).status).toBe(200);
  return { ada, bo };
}

/** Sign in and return a cookie-carrying agent. */
async function signIn(username: string, password = 'correct horse') {
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/login').send({ username, password });
  expect(res.body.status, JSON.stringify(res.body)).toBe('ok');
  return agent;
}

describe('sign-in', () => {
  it('is off by default and leaves the API open', async () => {
    const status = await request(app).get('/api/auth/status');
    expect(status.body.enabled).toBe(false);
    expect((await request(app).get('/api/bootstrap')).status).toBe(200);
  });

  it('needs an administrator with a username before it can be turned on', async () => {
    await member('Ada', 'ada');
    const res = await request(app).put('/api/auth/settings').send({ enabled: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/administrator/);
  });

  it('needs that administrator to have a password, so nobody else can claim the account', async () => {
    const ada = await member('Ada', 'ada');
    await request(app).patch(`/api/auth/accounts/${ada.id}`).send({ isAdmin: true });
    const res = await request(app).put('/api/auth/settings').send({ enabled: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/password/);
    await setPassword(ada.id);
    expect((await request(app).put('/api/auth/settings').send({ enabled: true })).status).toBe(200);
  });

  it('requires a session once on, and signs in with the password', async () => {
    await setup();
    expect((await request(app).get('/api/bootstrap')).status).toBe(401);

    const agent = request.agent(app);
    const ok = await agent.post('/api/auth/login').send({ username: 'ADA', password: 'correct horse' });
    expect(ok.body.status).toBe('ok');
    expect(ok.headers['set-cookie'][0]).toMatch(/HttpOnly/);
    expect((await agent.get('/api/bootstrap')).status).toBe(200);

    expect((await request(app).post('/api/auth/login').send({ username: 'ada' })).status).toBe(401);
    expect((await request(app).post('/api/auth/password').send({ username: 'ada', newPassword: 'taken over!' })).status).toBe(401);
  });

  it('never lets anyone choose the first password of an account', async () => {
    await setup();
    const admin = await signIn('ada');
    const cy = (await admin.post('/api/members').send({ name: 'Cy New', username: 'cy' })).body.result as { id: string };
    const unknown = await request(app).post('/api/auth/login').send({ username: 'nobody', password: 'anything 1' });
    for (const body of [{ username: 'cy' }, { username: 'cy', password: 'anything 1' }]) {
      const res = await request(app).post('/api/auth/login').send(body);
      // Answers exactly like an unknown username.
      expect(res.status).toBe(401);
      expect(res.body).toEqual(unknown.body);
    }
    const claim = await request(app).post('/api/auth/password').send({ username: 'cy', newPassword: 'taken over!' });
    expect(claim.status).toBe(401);
    expect(claim.headers['set-cookie']).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'auth.json'), 'utf8')).accounts[cy.id]?.passwordHash ?? null).toBeNull();

    // An administrator gives them a temporary password; they choose their own from it.
    await setPassword(cy.id, 'temporary 1', true, admin);
    expect((await request(app).post('/api/auth/login').send({ username: 'cy', password: 'temporary 1' })).body).toEqual({ status: 'change', reason: 'temporary' });
    const own = request.agent(app);
    expect((await own.post('/api/auth/password').send({ username: 'cy', newPassword: 'cy password 1' })).status).toBe(401);
    expect((await own.post('/api/auth/password').send({ username: 'cy', currentPassword: 'temporary 1', newPassword: 'cy password 1' })).status).toBe(200);
    expect((await own.get('/api/bootstrap')).status).toBe(200);
  });

  it('stores only a salted hash, never the password', async () => {
    const { ada } = await setup();
    await signIn('ada', 'correct horse');
    const file = fs.readFileSync(path.join(dir, 'auth.json'), 'utf8');
    expect(file).not.toContain('correct horse');
    expect(JSON.parse(file).accounts[ada.id].passwordHash).toMatch(/^scrypt\$/);
    // Nothing about passwords is sent to browsers.
    const agent = await signIn('ada', 'correct horse');
    expect(JSON.stringify((await agent.get('/api/bootstrap')).body)).not.toContain('scrypt');
  });

  it('attributes changes to the signed-in user, not the X-User header', async () => {
    await setup();
    const agent = await signIn('ada');
    const res = await agent.post('/api/workitems').set('X-User', 'Mallory').send({ type: 'Task', title: 'Mine' });
    expect(res.body.result.createdBy).toBe('Ada Admin');
  });

  it('rejects wrong passwords and locks the username after repeated failures', async () => {
    await setup();
    await signIn('ada');
    for (let i = 0; i < 5; i++) expect((await request(app).post('/api/auth/login').send({ username: 'ada', password: 'nope' })).status).toBe(401);
    expect((await request(app).post('/api/auth/login').send({ username: 'ada', password: 'correct horse' })).status).toBe(429);
    clock += 6 * 60_000;
    expect((await request(app).post('/api/auth/login').send({ username: 'ada', password: 'correct horse' })).body.status).toBe('ok');
  });

  it('expires passwords after the configured number of days', async () => {
    await setup();
    const agent = await signIn('ada');
    expect((await agent.get('/api/auth/status')).body.user.passwordExpiresAt).toBe(new Date(clock + 60 * DAY).toISOString());

    clock += 61 * DAY;
    expect((await agent.get('/api/bootstrap')).status).toBe(401);
    expect((await request(app).post('/api/auth/login').send({ username: 'ada', password: 'correct horse' })).body).toEqual({ status: 'change', reason: 'expired' });
    // The same password can't be reused.
    expect((await request(app).post('/api/auth/password').send({ username: 'ada', currentPassword: 'correct horse', newPassword: 'correct horse' })).status).toBe(400);
    const next = request.agent(app);
    expect((await next.post('/api/auth/password').send({ username: 'ada', currentPassword: 'correct horse', newPassword: 'battery staple' })).status).toBe(200);
    expect((await next.get('/api/bootstrap')).status).toBe(200);
  });

  it('lets administrators change the expiry period and session timeout', async () => {
    await setup();
    const agent = await signIn('ada');
    const res = await agent.put('/api/auth/settings').send({ passwordExpiryDays: 0, sessionTimeoutMinutes: 30 });
    expect(res.body.settings).toMatchObject({ passwordExpiryDays: 0, sessionTimeoutMinutes: 30 });
    expect((await agent.put('/api/auth/settings').send({ sessionTimeoutMinutes: 1 })).status).toBe(400);

    clock += 400 * DAY; // 0 = never expires, but the idle timeout still applies
    expect((await agent.get('/api/bootstrap')).status).toBe(401);
    const again = await signIn('ada');
    clock += 29 * 60_000;
    expect((await again.get('/api/bootstrap')).status).toBe(200); // activity resets the idle clock
    clock += 29 * 60_000;
    expect((await again.get('/api/bootstrap')).status).toBe(200);
    clock += 31 * 60_000;
    expect((await again.get('/api/bootstrap')).status).toBe(401);
  });

  it('limits administration to administrators', async () => {
    const { bo } = await setup();
    const user = await signIn('bo');
    expect((await user.get('/api/auth/admin')).status).toBe(403);
    expect((await user.put('/api/auth/settings').send({ enabled: false })).status).toBe(403);
    expect((await user.post(`/api/auth/accounts/${bo.id}/password`).send({ password: 'new password' })).status).toBe(403);
    expect((await user.post('/api/members').send({ name: 'Eve', username: 'eve' })).status).toBe(403);
    expect((await user.patch(`/api/members/${bo.id}`).send({ username: 'boss' })).status).toBe(403);
    // Ordinary work is still allowed.
    expect((await user.post('/api/workitems').send({ type: 'Task', title: 'ok' })).status).toBe(201);
  });

  it('lets administrators set a temporary password or reset someone else', async () => {
    const { bo } = await setup();
    const admin = await signIn('ada');
    const user = await signIn('bo');

    expect((await admin.post(`/api/auth/accounts/${bo.id}/password`).send({ password: 'temporary 1' })).status).toBe(200);
    expect((await user.get('/api/bootstrap')).status).toBe(401); // their sessions end
    expect((await request(app).post('/api/auth/login').send({ username: 'bo', password: 'temporary 1' })).body).toEqual({ status: 'change', reason: 'temporary' });
    expect((await request(app).post('/api/auth/password').send({ username: 'bo', currentPassword: 'temporary 1', newPassword: 'bo password 2' })).status).toBe(200);

    expect((await admin.post(`/api/auth/accounts/${bo.id}/reset`)).status).toBe(200);
    // A reset account can't be signed in to or claimed until an administrator sets a password.
    expect((await request(app).post('/api/auth/login').send({ username: 'bo', password: 'bo password 2' })).status).toBe(401);
    expect((await request(app).post('/api/auth/password').send({ username: 'bo', newPassword: 'taken over!' })).status).toBe(401);

    const view = (await admin.get('/api/auth/admin')).body;
    expect(view.accounts.find((a: { memberId: string }) => a.memberId === bo.id)).toMatchObject({ hasPassword: false, isAdmin: false });
  });

  it('never leaves the project without an administrator who can sign in', async () => {
    const { ada } = await setup();
    const admin = await signIn('ada');
    expect((await admin.patch(`/api/auth/accounts/${ada.id}`).send({ isAdmin: false })).status).toBe(400);
    expect((await admin.post(`/api/auth/accounts/${ada.id}/reset`)).status).toBe(400);
    expect((await admin.patch(`/api/members/${ada.id}`).send({ active: false })).status).toBe(400);
    expect((await admin.patch(`/api/members/${ada.id}`).send({ username: '' })).status).toBe(400);
    expect((await admin.delete(`/api/members/${ada.id}`)).status).toBe(400);
    expect((await admin.post('/api/backup/reset').send({ mode: 'demo' })).status).toBe(400);
    expect(store.db.members.find((m) => m.id === ada.id)?.active).toBe(true);
  });

  it('can be forced off for recovery', async () => {
    await setup();
    const recovery = new Store(dir, () => emptyDatabase());
    const forced = createApp({ store: recovery, snapshots: new SnapshotManager(recovery), auth: new AuthManager(recovery, { disabled: true }) });
    expect((await request(forced).get('/api/auth/status')).body).toMatchObject({ enabled: false, overridden: true });
    expect((await request(forced).get('/api/bootstrap')).status).toBe(200);
  });
});

describe('deployment behind a proxy', () => {
  it('keeps the health check public while sign-in is on', async () => {
    await setup();
    expect((await request(app).get('/api/bootstrap')).status).toBe(401);
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('marks the session cookie Secure only when a trusted proxy reports HTTPS', async () => {
    await setup();
    const cookieFor = async (target: ReturnType<typeof createApp>) => {
      const res = await request(target).post('/api/auth/login').set('X-Forwarded-Proto', 'https').send({ username: 'bo', password: 'correct horse' });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      return String(res.headers['set-cookie']);
    };
    // Without trust proxy the forwarded header is ignored.
    expect(await cookieFor(app)).not.toMatch(/Secure/);
    const proxied = createApp({ store, snapshots: new SnapshotManager(store), auth, trustProxy: 1 });
    expect(await cookieFor(proxied)).toMatch(/Secure/);
  });
});
