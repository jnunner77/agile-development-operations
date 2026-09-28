import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../server/app';
import { AuthManager } from '../server/auth';
import { emptyDatabase } from '../server/schema';
import { Security } from '../server/security';
import { SnapshotManager } from '../server/snapshots';
import { Store } from '../server/store';

const DAY = 86_400_000;
let dir: string;
let store: Store;
let auth: AuthManager;
let app: ReturnType<typeof createApp>;
let clock: number;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boards-tokens-'));
  store = new Store(dir, () => emptyDatabase());
  clock = Date.parse('2026-01-01T09:00:00Z');
  auth = new AuthManager(store, { now: () => clock });
  app = createApp({ store, snapshots: new SnapshotManager(store), auth, security: false });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

async function member(name: string, username?: string) {
  const res = await request(app).post('/api/members').send({ name, ...(username ? { username } : {}) });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.result as { id: string };
}

async function token(memberId: string, scope: 'read' | 'write' = 'write', expiresInDays = 90, agent: request.Agent | typeof app = app) {
  const res = await request(agent as typeof app).post('/api/auth/tokens').send({ name: 'Claude', memberId, scope, expiresInDays });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { token: string; info: { id: string; prefix: string } };
}

/** Admin "ada", regular user "bo", a "Claude" member with no password, then sign-in on. */
async function setup() {
  const ada = await member('Ada Admin', 'ada');
  const bo = await member('Bo User', 'bo');
  const claude = await member('Claude');
  await request(app).patch(`/api/auth/accounts/${ada.id}`).send({ isAdmin: true });
  const t = await token(claude.id);
  await request(app).put('/api/auth/settings').send({ enabled: true });
  return { ada, bo, claude, t };
}

async function signIn(username: string) {
  const agent = request.agent(app);
  await agent.post('/api/auth/login').send({ username });
  const res = await agent.post('/api/auth/password').send({ username, newPassword: 'correct horse' });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return agent;
}

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

describe('API tokens', () => {
  it('return the secret once and store only a hash', async () => {
    const m = await member('Claude');
    const { token: secret, info } = await token(m.id);
    expect(secret).toMatch(/^boards_[\w-]{40,}$/);
    expect(secret.startsWith(info.prefix)).toBe(true);
    const list = (await request(app).get('/api/auth/tokens')).body;
    expect(JSON.stringify(list)).not.toContain(secret);
    expect(list[0]).not.toHaveProperty('hash');
    const file = fs.readFileSync(path.join(dir, 'api-tokens.json'), 'utf8');
    expect(file).not.toContain(secret);
    expect(fs.readFileSync(path.join(dir, 'db.json'), 'utf8')).not.toContain(info.prefix);
    expect(JSON.stringify((await request(app).get('/api/backup/export')).body)).not.toContain(info.prefix);
  });

  it('let a script use the API as the token member while sign-in is on', async () => {
    const { claude, t } = await setup();
    expect((await request(app).get('/api/bootstrap')).status).toBe(401);
    expect((await request(app).get('/api/bootstrap').set(bearer(t.token))).status).toBe(200);
    const created = await request(app).post('/api/workitems').set(bearer(t.token)).send({ type: 'Product Backlog Item', title: 'Made by a script' });
    expect(created.status).toBe(201);
    expect(created.body.result.createdBy).toBe('Claude');
    // A forged X-User header can't change who the token acts as.
    const patched = await request(app).patch(`/api/workitems/${created.body.result.id}`).set(bearer(t.token)).set('X-User', 'someone-else').send({ title: 'Renamed' });
    expect(patched.body.result.changedBy).toBe('Claude');
    expect(claude.id).toBeTruthy();
  });

  it('enforce read-only tokens', async () => {
    const m = await member('Reader');
    const { token: secret } = await token(m.id, 'read');
    expect((await request(app).get('/api/bootstrap').set(bearer(secret))).status).toBe(200);
    const res = await request(app).post('/api/workitems').set(bearer(secret)).send({ type: 'Task', title: 'x' });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/read-only/);
  });

  it('reject unknown, expired, revoked and orphaned tokens, even with sign-in off', async () => {
    const m = await member('Claude');
    expect((await request(app).get('/api/bootstrap').set(bearer('boards_nope'))).status).toBe(401);
    expect((await request(app).get('/api/bootstrap').set(bearer('not-a-token'))).status).toBe(401);

    const short = await token(m.id, 'write', 1);
    clock += DAY + 1;
    expect((await request(app).get('/api/bootstrap').set(bearer(short.token))).status).toBe(401);

    const revoked = await token(m.id);
    expect((await request(app).delete(`/api/auth/tokens/${revoked.info.id}`)).status).toBe(204);
    expect((await request(app).get('/api/bootstrap').set(bearer(revoked.token))).status).toBe(401);

    const live = await token(m.id);
    await request(app).patch(`/api/members/${m.id}`).send({ active: false });
    expect((await request(app).get('/api/bootstrap').set(bearer(live.token))).status).toBe(401);
  });

  it('can never administer the project or mint more tokens', async () => {
    const ada = await member('Ada Admin', 'ada');
    await request(app).patch(`/api/auth/accounts/${ada.id}`).send({ isAdmin: true });
    // Even a token acting as an administrator.
    const { token: secret } = await token(ada.id);
    await request(app).put('/api/auth/settings').send({ enabled: true });
    for (const [method, url] of [
      ['get', '/api/auth/admin'],
      ['get', '/api/auth/tokens'],
      ['post', '/api/auth/tokens'],
      ['get', '/api/integrations/github'],
      ['post', '/api/backup/reset'],
      ['post', '/api/members'],
    ] as const) {
      const res = await request(app)[method](url).set(bearer(secret)).send({ name: 'x', mode: 'empty' });
      expect(res.status, `${method} ${url}`).toBe(403);
    }
    expect((await request(app).get('/api/auth/status').set(bearer(secret))).status).toBe(200);
  });

  it('let people manage their own tokens and administrators manage everyone', async () => {
    const { ada, bo, claude } = await setup();
    const boAgent = await signIn('bo');
    expect((await boAgent.post('/api/auth/tokens').send({ name: 'mine', scope: 'read' })).status).toBe(201);
    expect((await boAgent.post('/api/auth/tokens').send({ name: 'theirs', memberId: claude.id })).status).toBe(403);
    const mine = (await boAgent.get('/api/auth/tokens')).body as { id: string; memberId: string }[];
    expect(mine.every((t) => t.memberId === bo.id)).toBe(true);

    const adaAgent = await signIn('ada');
    const all = (await adaAgent.get('/api/auth/tokens')).body as { id: string; memberId: string }[];
    expect(all.length).toBe(2);
    const claudes = all.find((t) => t.memberId === claude.id)!;
    expect((await boAgent.delete(`/api/auth/tokens/${claudes.id}`)).status).toBe(403);
    expect((await adaAgent.delete(`/api/auth/tokens/${claudes.id}`)).status).toBe(204);
    expect((await adaAgent.post('/api/auth/tokens').send({ name: 'for bo', memberId: bo.id, scope: 'write' })).status).toBe(201);
    expect(ada.id).toBeTruthy();
  });

  it('validate expiry limits', async () => {
    const m = await member('Claude');
    const res = await request(app).post('/api/auth/tokens').send({ name: 'x', memberId: m.id, expiresInDays: 400 });
    expect(res.status).toBe(400);
  });

  it('count bad tokens toward the temporary IP block', async () => {
    const guarded = createApp({
      store,
      snapshots: new SnapshotManager(store),
      auth,
      trustProxy: 1,
      security: new Security({ ban: { authFailures: 3, violations: 1000, notFound: 1000, windowMs: 60_000, durationMs: 60_000 } }, () => clock),
    });
    for (let i = 0; i < 3; i++) await request(guarded).get('/api/bootstrap').set('X-Forwarded-For', '7.7.7.7').set(bearer(`boards_guess${i}`));
    expect((await request(guarded).get('/api/bootstrap').set('X-Forwarded-For', '7.7.7.7')).status).toBe(403);
  });
});
