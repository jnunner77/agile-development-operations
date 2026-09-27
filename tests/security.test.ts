import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../server/app';
import { AuthManager } from '../server/auth';
import { emptyDatabase } from '../server/schema';
import { Security, TokenBucket, type SecurityOptions } from '../server/security';
import { SnapshotManager } from '../server/snapshots';
import { Store } from '../server/store';

let dir: string;
let store: Store;
let clock: number;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boards-security-'));
  store = new Store(dir, () => emptyDatabase());
  clock = Date.parse('2026-01-01T09:00:00Z');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function build(options: Partial<SecurityOptions> = {}) {
  const auth = new AuthManager(store, { now: () => clock });
  const security = new Security(options, () => clock);
  const app = createApp({ store, snapshots: new SnapshotManager(store), auth, security, trustProxy: 1 });
  return { app, auth, security };
}

/** Requests appear to come from `ip` via the trusted proxy. */
const from = (ip: string) => ({ 'X-Forwarded-For': ip });

async function enableSignIn(app: ReturnType<typeof build>['app']) {
  const res = await request(app).post('/api/members').send({ name: 'Ada', username: 'ada' });
  const id = res.body.result.id as string;
  await request(app).patch(`/api/auth/accounts/${id}`).send({ isAdmin: true });
  await request(app).put('/api/auth/settings').send({ enabled: true });
}

describe('token bucket', () => {
  it('allows a burst, then refills at the configured rate', () => {
    let t = 0;
    const b = new TokenBucket({ burst: 3, perMinute: 60 }, 100, () => t);
    expect([1, 2, 3].map(() => b.take('k').ok)).toEqual([true, true, true]);
    const denied = b.take('k');
    expect(denied.ok).toBe(false);
    expect(!denied.ok && denied.retryAfterMs).toBe(1000);
    t += 1000;
    expect(b.take('k').ok).toBe(true);
    expect(b.take('other').ok).toBe(true);
  });

  it('never tracks more than the configured number of clients', () => {
    const b = new TokenBucket({ burst: 2, perMinute: 1 }, 100, () => 0);
    for (let i = 0; i < 1000; i++) b.take(`ip${i}`);
    expect(b.size).toBeLessThanOrEqual(100);
  });
});

describe('rate limits', () => {
  it('limits each IP independently and reports Retry-After', async () => {
    const { app } = build({ ip: { burst: 3, perMinute: 60 } });
    for (let i = 0; i < 3; i++) expect((await request(app).get('/api/bootstrap').set(from('1.1.1.1'))).status).toBe(200);
    const limited = await request(app).get('/api/bootstrap').set(from('1.1.1.1'));
    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toBe('1');
    expect((await request(app).get('/api/bootstrap').set(from('2.2.2.2'))).status).toBe(200);
    clock += 1000;
    expect((await request(app).get('/api/bootstrap').set(from('1.1.1.1'))).status).toBe(200);
  });

  it('never limits or blocks the health check', async () => {
    const { app } = build({ ip: { burst: 1, perMinute: 1 } });
    for (let i = 0; i < 20; i++) expect((await request(app).get('/api/health').set(from('3.3.3.3'))).status).toBe(200);
  });

  it('limits changes separately from reads', async () => {
    const { app } = build({ mutations: { burst: 2, perMinute: 1 } });
    const create = () => request(app).post('/api/workitems').set(from('4.4.4.4')).send({ type: 'Task', title: 't' });
    expect((await create()).status).toBe(201);
    expect((await create()).status).toBe(201);
    expect((await create()).body.error).toMatch(/Too many changes/);
    expect((await request(app).get('/api/bootstrap').set(from('4.4.4.4'))).status).toBe(200);
  });

  it('holds anonymous callers to a strict limit while sign-in is on', async () => {
    const { app } = build({ anonymous: { burst: 2, perMinute: 1 } });
    await enableSignIn(app);
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await request(app).get('/api/bootstrap').set(from('5.5.5.5'))).status);
    expect(statuses).toEqual([401, 401, 429]);
  });

  it('limits sign-in attempts per IP', async () => {
    const { app } = build({ signIn: { burst: 3, perMinute: 1 } });
    await enableSignIn(app);
    const attempt = () => request(app).post('/api/auth/login').set(from('6.6.6.6')).send({ username: 'nobody', password: 'wrong password' });
    for (let i = 0; i < 3; i++) expect((await attempt()).status).toBe(401);
    expect((await attempt()).status).toBe(429);
    // Another address is unaffected.
    expect((await request(app).post('/api/auth/login').set(from('7.7.7.7')).send({ username: 'nobody', password: 'x' })).status).toBe(401);
  });

  it('limits expensive backup operations', async () => {
    const { app } = build({ heavy: { burst: 2, perMinute: 1 } });
    const snap = () => request(app).post('/api/snapshots').set(from('8.8.8.8')).send({ name: 's' });
    expect((await snap()).status).toBe(201);
    expect((await snap()).status).toBe(201);
    expect((await snap()).status).toBe(429);
  });
});

describe('temporary bans', () => {
  it('blocks an IP after repeated failed sign-ins, then lifts the block', async () => {
    const { app } = build({ signIn: { burst: 100, perMinute: 100 }, ban: { authFailures: 4, violations: 1000, notFound: 1000, windowMs: 60_000, durationMs: 10 * 60_000 } });
    await enableSignIn(app);
    for (let i = 0; i < 4; i++) {
      await request(app).post('/api/auth/login').set(from('9.9.9.9')).send({ username: `user${i}`, password: 'nope nope' });
    }
    const blocked = await request(app).get('/api/auth/status').set(from('9.9.9.9'));
    expect(blocked.status).toBe(403);
    expect(blocked.body.error).toMatch(/temporarily blocked/);
    expect((await request(app).get('/api/health').set(from('9.9.9.9'))).status).toBe(403);
    expect((await request(app).get('/api/auth/status').set(from('10.0.0.1'))).status).toBe(200);
    clock += 10 * 60_000 + 1;
    expect((await request(app).get('/api/auth/status').set(from('9.9.9.9'))).status).toBe(200);
  });

  it('blocks clients probing for API endpoints', async () => {
    const { app } = build({ ban: { notFound: 5, authFailures: 1000, violations: 1000, windowMs: 60_000, durationMs: 60_000 } });
    for (let i = 0; i < 5; i++) await request(app).get(`/api/admin${i}`).set(from('11.1.1.1'));
    expect((await request(app).get('/api/bootstrap').set(from('11.1.1.1'))).status).toBe(403);
  });

  it('blocks clients that keep hitting rate limits', async () => {
    const { app } = build({ ip: { burst: 1, perMinute: 1 }, ban: { violations: 3, authFailures: 1000, notFound: 1000, windowMs: 60_000, durationMs: 60_000 } });
    const statuses = [];
    for (let i = 0; i < 5; i++) statuses.push((await request(app).get('/api/bootstrap').set(from('12.1.1.1'))).status);
    expect(statuses).toEqual([200, 429, 429, 429, 403]);
  });
});

describe('request hardening', () => {
  it('rejects cross-site changes but allows same-origin ones', async () => {
    const { app } = build();
    const body = { type: 'Task', title: 'x' };
    expect((await request(app).post('/api/workitems').set('Origin', 'https://evil.example').send(body)).status).toBe(403);
    expect((await request(app).post('/api/workitems').set('Sec-Fetch-Site', 'cross-site').send(body)).status).toBe(403);
    expect((await request(app).post('/api/workitems').set('Origin', 'null').send(body)).status).toBe(403);
    const same = await request(app).post('/api/workitems').set('Host', 'boards.example').set('Origin', 'https://boards.example').send(body);
    expect(same.status).toBe(201);
    // Reads are never blocked by the origin check.
    expect((await request(app).get('/api/bootstrap').set('Origin', 'https://evil.example')).status).toBe(200);
  });

  it('rejects oversized bodies, except an admin backup import', async () => {
    const { app } = build();
    const big = 'x'.repeat(3 * 1024 * 1024);
    expect((await request(app).post('/api/workitems').set('Content-Type', 'application/json').send(JSON.stringify({ type: 'Task', title: 'x', description: big }))).status).toBe(413);
    const backup = { ...store.db, workItems: [{ id: 1, type: 'Task', title: 'Big', description: big }] };
    expect((await request(app).post('/api/backup/import').send(backup)).status).toBe(200);
  });

  it('refuses a large import from someone who is not an administrator', async () => {
    const { app } = build();
    await enableSignIn(app);
    const res = await request(app).post('/api/backup/import').set('Content-Type', 'application/json').send(JSON.stringify({ data: 'x'.repeat(10 * 1024 * 1024) }));
    expect(res.status).toBe(401);
  });

  it('caps live-update connections per IP', async () => {
    const { app, security } = build({ streamsPerIp: 2 });
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    const controllers = [new AbortController(), new AbortController()];
    try {
      const open = await Promise.all(controllers.map((c) => fetch(`http://127.0.0.1:${port}/api/events`, { signal: c.signal })));
      expect(open.map((r) => r.status)).toEqual([200, 200]);
      expect(security.stats.streamsOpen).toBe(2);
      expect((await fetch(`http://127.0.0.1:${port}/api/events`)).status).toBe(429);
      controllers[0].abort();
      await new Promise((r) => setTimeout(r, 100));
      expect(security.stats.streamsOpen).toBe(1);
    } finally {
      controllers.forEach((c) => c.abort());
      server.closeAllConnections();
      server.close();
    }
  });

  it('sends strict security headers and never caches API responses', async () => {
    const { app } = build();
    const res = await request(app).get('/api/bootstrap');
    expect(res.headers['content-security-policy']).toMatch(/default-src 'self'/);
    expect(res.headers['content-security-policy']).toMatch(/frame-ancestors 'none'/);
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

describe('sessions', () => {
  it('end after 24 hours even when active', async () => {
    const { app } = build();
    await enableSignIn(app);
    const agent = request.agent(app);
    await agent.post('/api/auth/login').send({ username: 'ada' });
    expect((await agent.post('/api/auth/password').send({ username: 'ada', newPassword: 'correct horse' })).status).toBe(200);
    for (let h = 0; h < 23; h++) {
      clock += 60 * 60_000;
      expect((await agent.get('/api/bootstrap')).status).toBe(200);
    }
    clock += 61 * 60_000;
    expect((await agent.get('/api/bootstrap')).status).toBe(401);
  });
});

describe('allowlist', () => {
  it('matches exact addresses and IPv4 ranges', async () => {
    const { ipMatcher } = await import('../server/security');
    const m = ipMatcher(['203.0.113.0/24', '198.51.100.7', '2001:db8::1', ' ']);
    expect(m('203.0.113.200')).toBe(true);
    expect(m('::ffff:203.0.113.5')).toBe(true);
    expect(m('203.0.114.1')).toBe(false);
    expect(m('198.51.100.7')).toBe(true);
    expect(m('198.51.100.8')).toBe(false);
    expect(m('2001:DB8::1')).toBe(true);
    expect(ipMatcher([])('1.2.3.4')).toBe(false);
  });

  it('never limits or blocks trusted networks', async () => {
    const { app } = build({ ip: { burst: 1, perMinute: 1 }, allowlist: ['10.1.0.0/16'], ban: { violations: 2, authFailures: 1000, notFound: 1000, windowMs: 60_000, durationMs: 60_000 } });
    for (let i = 0; i < 10; i++) expect((await request(app).get('/api/bootstrap').set(from('10.1.2.3'))).status).toBe(200);
    expect((await request(app).get('/api/bootstrap').set(from('10.2.0.1'))).status).toBe(200);
    expect((await request(app).get('/api/bootstrap').set(from('10.2.0.1'))).status).toBe(429);
  });
});
