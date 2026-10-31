import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { Caller } from '#application/caller.ts';
import { ResolveCaller } from '#application/sign-in/resolve-caller.ts';
import type { Member } from '#domain/types.ts';
import type { Identity } from '#application/sign-in/identity.ts';
import { emptyDatabase } from '#infrastructure/json-store/schema.ts';
import { MemoryChangeFeed } from '#infrastructure/memory/change-feed.ts';
import type { RequestContext } from '#presentation/http/context.ts';
import { clientAddress, trustFunction } from '#presentation/http/pipeline/client-address.ts';
import { requestPipeline } from '#presentation/http/pipeline/pipeline.ts';
import { Security } from '#presentation/http/pipeline/security.ts';
import { staticFiles } from '#presentation/http/pipeline/static-files.ts';
import { sendJson } from '#presentation/http/respond.ts';
import { Router } from '#presentation/http/router.ts';

const BO: Member = { id: 'm2', name: 'Bo', username: 'bo', email: '', color: '#0078d4', active: true };

function request(remoteAddress: string, headers: Record<string, string> = {}): http.IncomingMessage {
  const socket = new Socket();
  Object.defineProperty(socket, 'remoteAddress', { value: remoteAddress });
  const req = new http.IncomingMessage(socket);
  req.headers = headers;
  return req;
}

describe('client addresses behind proxies', () => {
  const forwarded = { 'x-forwarded-for': '203.0.113.9, 10.0.0.2', 'x-forwarded-proto': 'https' };

  it('ignore forwarded headers unless the proxy is trusted', () => {
    assert.deepEqual(clientAddress(request('10.0.0.1', forwarded), trustFunction(undefined)), { ip: '10.0.0.1', secure: false });
    assert.deepEqual(clientAddress(request('10.0.0.1', forwarded), trustFunction(false)), { ip: '10.0.0.1', secure: false });
  });

  it('walk back as many hops as are trusted', () => {
    assert.deepEqual(clientAddress(request('10.0.0.1', forwarded), trustFunction(1)), { ip: '10.0.0.2', secure: true });
    assert.deepEqual(clientAddress(request('10.0.0.1', forwarded), trustFunction(2)), { ip: '203.0.113.9', secure: true });
    assert.deepEqual(clientAddress(request('10.0.0.1', forwarded), trustFunction(true)), { ip: '203.0.113.9', secure: true });
    assert.deepEqual(clientAddress(request('10.0.0.1', {}), trustFunction(true)), { ip: '10.0.0.1', secure: false });
  });

  it('trust listed addresses, ranges and named ranges, IPv4 and IPv6', () => {
    assert.equal(clientAddress(request('10.0.0.1', forwarded), trustFunction('10.0.0.0/8')).ip, '203.0.113.9');
    assert.equal(clientAddress(request('10.0.0.1', forwarded), trustFunction('10.0.0.1')).ip, '10.0.0.2');
    assert.equal(clientAddress(request('::ffff:127.0.0.1', forwarded), trustFunction('loopback')).ip, '10.0.0.2');
    assert.equal(clientAddress(request('::1', forwarded), trustFunction('loopback, uniquelocal')).ip, '203.0.113.9');
    assert.equal(clientAddress(request('fd00::5', { 'x-forwarded-for': '2001:db8::1' }), trustFunction('fc00::/7')).ip, '2001:db8::1');
    assert.equal(clientAddress(request('192.0.2.1', forwarded), trustFunction('loopback')).secure, false);
    assert.equal(clientAddress(request('10.1.2.3', forwarded), trustFunction('10.0.0.0/255.0.0.0')).ip, '203.0.113.9');
    for (const bad of ['not-an-address', '10.0.0.0/', '10.0.0.0/0', '10.0.0.0/-1', '10.0.0.0/33', '10.0.0.0/255.0.255.0', '10.0.0.0/0.0.0.0', '::1/129', '10.0.0.0/8/8']) {
      assert.throws(() => trustFunction(bad), /TRUST_PROXY/, bad);
    }
  });

  it('uses IPv4 prefixes for mapped IPv4 ranges', () => {
    const spoofed = { 'x-forwarded-for': '203.0.113.9', 'x-forwarded-proto': 'https' };
    for (const range of ['::ffff:10.0.0.1/8', '::ffff:127.0.0.1/8']) {
      assert.deepEqual(clientAddress(request('203.0.113.7', spoofed), trustFunction(range)), { ip: '203.0.113.7', secure: false }, range);
    }
    assert.equal(clientAddress(request('10.2.3.4', {}), trustFunction('::ffff:10.0.0.1/8')).ip, '10.2.3.4');
    assert.throws(() => trustFunction('::ffff:10.0.0.1/33'), /TRUST_PROXY/);
  });
});

describe('static files', () => {
  let dir: string;
  let server: http.Server;
  let base: string;

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boards-static-'));
    fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>Boards</title>');
    fs.mkdirSync(path.join(dir, 'assets'));
    fs.writeFileSync(path.join(dir, 'assets', 'app.js'), 'console.log(1)');
    fs.writeFileSync(path.join(dir, '.env'), 'SECRET=1');
    fs.writeFileSync(path.join(os.tmpdir(), 'boards-outside.txt'), 'outside');
    const serve = staticFiles(dir);
    server = http.createServer((req, res) => {
      void serve(req, res, (req.url ?? '/').split('?')[0] ?? '/').then((handled) => {
        if (!handled) res.writeHead(404).end('none');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    base = `http://127.0.0.1:${address.port}`;
  });

  after(() => {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('serve files with their type, and validate with an ETag', async () => {
    const res = await fetch(`${base}/assets/app.js`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.equal(await res.text(), 'console.log(1)');
    const etag = res.headers.get('etag') ?? '';
    assert.equal((await fetch(`${base}/assets/app.js`, { headers: { 'If-None-Match': etag } })).status, 304);
    const head = await fetch(`${base}/assets/app.js`, { method: 'HEAD' });
    assert.equal(head.headers.get('content-length'), '14');
  });

  it('answer other pages with index.html, never a file outside the folder or a dotfile', async () => {
    for (const p of ['/', '/boards/sprint', '/.env', '/%2e%2e/boards-outside.txt', '/assets/%2e%2e/%2e%2e/boards-outside.txt', '/%E0%A4%A']) {
      const res = await fetch(`${base}${p}`);
      assert.equal(await res.text(), '<!doctype html><title>Boards</title>', p);
    }
    assert.equal((await fetch(`${base}/assets/app.js`, { method: 'POST' })).status, 404);
  });

  it('refuse traversal however it is spelled (sent as-is, without URL normalization)', async () => {
    const raw = (p: string) =>
      new Promise<string>((resolve, reject) => {
        http
          .get(`${base}/`, { path: p }, (res) => {
            let body = '';
            res.on('data', (d: Buffer) => (body += d.toString()));
            res.on('end', () => resolve(body));
          })
          .on('error', reject);
      });
    for (const p of ['/../boards-outside.txt', '/%2e%2e/boards-outside.txt', '/assets/..%2f..%2fboards-outside.txt', '/..%5cboards-outside.txt']) {
      assert.equal(await raw(p), '<!doctype html><title>Boards</title>', p);
    }
  });
});

describe('the request pipeline', () => {
  let server: http.Server;
  let base: string;
  let signInOn = false;
  let clock = 0;
  const feed = new MemoryChangeFeed();
  const seen: { caller: Caller; url: string | undefined; secure: boolean }[] = [];
  let identified = 0;

  const identityFor = (req: http.IncomingMessage): Identity => {
    const signedIn = req.headers.authorization === 'Bearer good';
    return {
      signInEnabled: signInOn,
      member: signedIn ? { id: 'm1', name: 'Ann', username: 'ann', email: '', color: '#0078d4', active: true } : null,
      isAdmin: signedIn,
      via: signedIn ? 'session' : 'none',
      token: null,
      invalidToken: req.headers.authorization === 'Bearer bad',
    };
  };

  before(async () => {
    const routes = (context: RequestContext) =>
      new Router()
        .add('GET', '/things', async (req, res) => {
          seen.push({ caller: context.caller(req, res), url: req.url, secure: context.secure(req, res) });
          sendJson(res, 200, { ok: true });
        })
        .add('POST', '/things', async (req, res) => {
          if (context.heavyOperation(req, res)) sendJson(res, 201, { ok: true });
        })
        .add('GET', '/boom', async () => {
          throw new Error('boom');
        })
        .add('GET', '/missing-record', async () => {
          throw new RangeError('Work item 9 not found');
        });
    const handler = requestPipeline({
      routes,
      authenticator: {
        identify: async (req) => {
          identified++;
          return { identity: identityFor(req), sessionToken: undefined };
        },
        stillSignedIn: async () => true,
      },
      signInEnabled: () => signInOn,
      resolveCaller: new ResolveCaller({ team: { all: async () => [BO], findById: async (id) => (id === 'm2' ? BO : undefined) } }),
      loadProject: { execute: async () => ({ db: emptyDatabase(), serverTime: '2026-03-02T10:00:00.000Z' }) },
      watchChanges: { execute: (listener) => ({ version: 7, stop: feed.subscribe(listener) }) },
      security: new Security({ ip: { burst: 50, perMinute: 60 }, heavy: { burst: 1, perMinute: 1 }, ban: { violations: 1000, authFailures: 2, notFound: 1000, windowMs: 60_000, durationMs: 60_000 } }, () => clock),
      trustProxy: 1,
      describeError: (error) => (error instanceof RangeError ? { status: 404, message: error.message } : undefined),
    });
    server = http.createServer(handler);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    base = `http://127.0.0.1:${address.port}`;
  });

  after(() => {
    server.close();
  });

  beforeEach(() => {
    signInOn = false;
    seen.length = 0;
    identified = 0;
    clock += 3_600_000; // fresh rate limits
  });

  const get = (p: string, headers: Record<string, string> = {}) => fetch(`${base}${p}`, { headers });

  it('sets security headers everywhere and no-store on the API', async () => {
    const res = await get('/api/health');
    assert.deepEqual(await res.json(), { status: 'ok' });
    assert.match(res.headers.get('content-security-policy') ?? '', /default-src 'self'/);
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(identified, 0);
    const outside = await get('/somewhere');
    assert.equal(outside.status, 404);
    assert.equal(outside.headers.get('x-content-type-options'), 'nosniff');
  });

  it('hands API routes the caller, the path below /api, and the scheme', async () => {
    await get('/API/things?x=1', { 'X-User': encodeURIComponent('Bo'), 'X-Client-Id': 'tab-1', 'X-Forwarded-Proto': 'https' });
    assert.equal(seen[0]?.url, '/things?x=1');
    assert.equal(seen[0]?.secure, true);
    assert.deepEqual(seen[0]?.caller, { name: 'Bo', memberId: 'm2', mayModerateComments: true, admin: 'granted', origin: 'tab-1' });
    await get('/api/things', { 'X-User': '%E0%A4%A' });
    assert.equal(seen[1]?.caller.name, 'Anonymous');
  });

  it('applies the sign-in gate, attributing work to the signed-in member', async () => {
    signInOn = true;
    const refused = await get('/api/things', { 'X-User': 'm2' });
    assert.deepEqual([refused.status, await refused.json()], [401, { error: 'Please sign in', code: 'signin' }]);
    await get('/api/things', { 'X-User': 'm2', Authorization: 'Bearer good' });
    assert.deepEqual([seen[0]?.caller.name, seen[0]?.caller.memberId], ['m1', 'm1']);
  });

  it('turns away cross-site changes', async () => {
    const res = await fetch(`${base}/api/things`, { method: 'POST', headers: { Origin: 'https://evil.example' } });
    assert.deepEqual([res.status, await res.json()], [403, { error: 'Cross-site requests are not allowed' }]);
  });

  it('serves bootstrap, 404s unknown API paths, and maps errors', async () => {
    assert.equal(((await (await get('/api/bootstrap')).json()) as { serverTime: string }).serverTime, '2026-03-02T10:00:00.000Z');
    const missing = await get('/api/nope');
    assert.deepEqual([missing.status, await missing.json()], [404, { error: 'Not found' }]);
    const described = await get('/api/missing-record');
    assert.deepEqual([described.status, await described.json()], [404, { error: 'Work item 9 not found' }]);
    const original = console.error;
    console.error = () => {};
    try {
      const boom = await get('/api/boom');
      assert.deepEqual([boom.status, await boom.json()], [500, { error: 'Internal server error' }]);
    } finally {
      console.error = original;
    }
  });

  it('limits expensive operations through the request context', async () => {
    const post = () => fetch(`${base}/api/things`, { method: 'POST', headers: { 'X-Forwarded-For': '198.51.100.7' } });
    assert.equal((await post()).status, 201);
    const limited = await post();
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('retry-after'), '60');
  });

  it('does not limit expensive operations for a signed-in administrator', async () => {
    signInOn = true;
    const post = () => fetch(`${base}/api/things`, { method: 'POST', headers: { 'X-Forwarded-For': '198.51.100.9', Authorization: 'Bearer good' } });
    assert.equal((await post()).status, 201);
    assert.equal((await post()).status, 201);
  });

  it('bans clients that keep presenting bad tokens', async () => {
    const from = { 'X-Forwarded-For': '198.51.100.8', Authorization: 'Bearer bad' };
    signInOn = true;
    for (let i = 0; i < 2; i++) assert.equal((await get('/api/things', from)).status, 401);
    const banned = await get('/api/health', { 'X-Forwarded-For': '198.51.100.8' });
    assert.equal(banned.status, 403);
    assert.equal(banned.headers.get('connection'), 'close');
  });

  it('streams changes to browsers, starting with the version', async () => {
    const controller = new AbortController();
    const res = await fetch(`${base}/api/events`, { signal: controller.signal });
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    const reader = res.body?.getReader();
    assert.ok(reader);
    const decoder = new TextDecoder();
    let text = '';
    const until = async (needle: string) => {
      while (!text.includes(needle)) {
        const chunk = await reader.read();
        if (chunk.done) break;
        text += decoder.decode(chunk.value);
      }
    };
    await until('\n\n');
    assert.equal(text, 'event: hello\ndata: {"version":7}\n\n');
    feed.emit({ version: 8 }, 'tab-2');
    await until('tab-2');
    assert.match(text, /data: \{"delta":\{"version":8\},"origin":"tab-2"\}/);
    controller.abort();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(feed.listening, 0);
  });
});

describe('the request pipeline under pressure', () => {
  const servers: http.Server[] = [];
  let clock = 0;
  let stillSignedIn = true;
  const feed = new MemoryChangeFeed();

  after(() => {
    for (const server of servers) server.close();
  });

  async function serve(options: ConstructorParameters<typeof Security>[0], identify: () => Identity = () => ({ signInEnabled: true, member: null, isAdmin: false, via: 'none', token: null, invalidToken: false })) {
    const security = new Security(options, () => clock);
    const handler = requestPipeline({
      routes: () =>
        new Router().add('POST', '/auth/login', async (_req, res) => {
          await new Promise((r) => setTimeout(r, 30)); // a slow password check
          sendJson(res, 401, { error: 'Incorrect username or password' });
        }),
      authenticator: { identify: async () => ({ identity: identify(), sessionToken: 'session' }), stillSignedIn: async () => stillSignedIn },
      signInEnabled: () => false,
      resolveCaller: new ResolveCaller({ team: { all: async () => [], findById: async () => undefined } }),
      loadProject: { execute: async () => ({ db: emptyDatabase(), serverTime: '' }) },
      watchChanges: { execute: (listener) => ({ version: 1, stop: feed.subscribe(listener) }) },
      security,
      trustProxy: 1,
    });
    const server = http.createServer(handler);
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    return { base: `http://127.0.0.1:${address.port}`, security };
  }

  const signedIn = (): Identity => ({ signInEnabled: true, member: BO, isAdmin: false, via: 'session', token: null, invalidToken: false });

  it('never limits the health check, and turns banned clients away everywhere', async () => {
    const { base } = await serve({ ip: { burst: 1, perMinute: 1 }, ban: { violations: 2, authFailures: 1000, notFound: 1000, windowMs: 60_000, durationMs: 60_000 } });
    const from = (ip: string) => ({ headers: { 'X-Forwarded-For': ip } });
    for (let i = 0; i < 5; i++) assert.equal((await fetch(`${base}/api/health`, from('192.0.2.1'))).status, 200);
    assert.equal((await fetch(`${base}/somewhere`, from('192.0.2.2'))).status, 404);
    const limited = await fetch(`${base}/somewhere`, from('192.0.2.2'));
    assert.deepEqual([limited.status, limited.headers.get('retry-after')], [429, '60']);
    await fetch(`${base}/somewhere`, from('192.0.2.2'));
    const banned = await fetch(`${base}/index.html`, from('192.0.2.2'));
    assert.deepEqual([banned.status, await banned.json()], [403, { error: 'Access from your network is temporarily blocked.' }]);
  });

  it('limits sign-in attempts at any spelling of the path, and caps password checks running at once', async () => {
    const { base, security } = await serve({ signIn: { burst: 2, perMinute: 1 }, hashConcurrency: 1, ban: { violations: 1000, authFailures: 1000, notFound: 1000, windowMs: 60_000, durationMs: 60_000 } });
    const attempt = (ip: string) => fetch(`${base}/api/AUTH/login`, { method: 'POST', headers: { 'X-Forwarded-For': ip, 'Content-Type': 'application/json' }, body: '{}' });
    const [first, second] = await Promise.all([attempt('192.0.2.3'), attempt('192.0.2.4')]);
    const statuses = [first.status, second.status].sort();
    assert.deepEqual(statuses, [401, 503]);
    const busy = first.status === 503 ? first : second;
    assert.equal(busy.headers.get('retry-after'), '2');
    assert.equal(security.stats.hashing, 0);
    assert.equal((await attempt('192.0.2.3')).status, 401);
    const limited = await attempt('192.0.2.3');
    assert.deepEqual([limited.status, limited.headers.get('retry-after')], [429, '60']);
  });

  it('caps live connections, frees them when browsers leave, and ends streams when the session does', async () => {
    const { base, security } = await serve({ streamsPerIp: 1, streamsPerUser: 10, streamsTotal: 10 }, signedIn);
    const controller = new AbortController();
    const open = await fetch(`${base}/api/events`, { signal: controller.signal, headers: { 'X-Forwarded-For': '192.0.2.5' } });
    assert.equal(open.status, 200);
    assert.equal(security.stats.streamsOpen, 1);
    const second = await fetch(`${base}/api/events`, { headers: { 'X-Forwarded-For': '192.0.2.5' } });
    assert.deepEqual([second.status, second.headers.get('retry-after')], [429, '10']);
    controller.abort();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(security.stats.streamsOpen, 0);

    // Signed out (or timed out): the next message ends the stream instead.
    const watched = await fetch(`${base}/api/events`, { headers: { 'X-Forwarded-For': '192.0.2.6' } });
    stillSignedIn = false;
    feed.emit({ version: 2 });
    const text = await watched.text();
    assert.equal(text, 'event: hello\ndata: {"version":1}\n\n');
    assert.equal(security.stats.streamsOpen, 0);
    assert.equal(feed.listening, 0);
    stillSignedIn = true;
  });

  const admin = (): Identity => ({ ...signedIn(), isAdmin: true });

  it('never limits a signed-in administrator, though others from the same address are limited and blocked', async () => {
    const options = { ip: { burst: 3, perMinute: 1 }, user: { burst: 3, perMinute: 1 }, mutations: { burst: 3, perMinute: 1 }, ban: { violations: 5, authFailures: 1000, notFound: 1000, windowMs: 60_000, durationMs: 60_000 } };
    const post = (base: string, ip: string) => fetch(`${base}/api/nothing`, { method: 'POST', headers: { 'X-Forwarded-For': ip } });
    const asAdmin = await serve(options, admin);
    for (let i = 0; i < 10; i++) assert.notEqual((await post(asAdmin.base, '192.0.2.10')).status, 429);
    const asMember = await serve(options, signedIn);
    const statuses: number[] = [];
    for (let i = 0; i < 10; i++) statuses.push((await post(asMember.base, '192.0.2.11')).status);
    assert.ok(statuses.includes(429));
    assert.equal(statuses.at(-1), 403);
  });

  it('still limits an administrator’s sign-in attempts', async () => {
    const { base } = await serve({ signIn: { burst: 1, perMinute: 1 }, ban: { violations: 1000, authFailures: 1000, notFound: 1000, windowMs: 60_000, durationMs: 60_000 } }, admin);
    const attempt = () => fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'X-Forwarded-For': '192.0.2.12', 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal((await attempt()).status, 401);
    assert.equal((await attempt()).status, 429);
  });

  it('lets an administrator past the per-person and per-address live connection caps, but not the server-wide one', async () => {
    const { base, security } = await serve({ streamsPerIp: 1, streamsPerUser: 1, streamsTotal: 3 }, admin);
    const controllers = [0, 1, 2].map(() => new AbortController());
    for (const c of controllers) assert.equal((await fetch(`${base}/api/events`, { signal: c.signal, headers: { 'X-Forwarded-For': '192.0.2.13' } })).status, 200);
    assert.equal(security.stats.streamsOpen, 3);
    const full = await fetch(`${base}/api/events`, { headers: { 'X-Forwarded-For': '192.0.2.13' } });
    assert.equal(full.status, 503);
    for (const c of controllers) c.abort();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(security.stats.streamsOpen, 0);
  });

  it('never counts an administrator’s missing endpoints towards a block', async () => {
    const options = { ban: { violations: 1000, authFailures: 1000, notFound: 2, windowMs: 60_000, durationMs: 60_000 } };
    const asAdmin = await serve(options, admin);
    for (let i = 0; i < 6; i++) assert.equal((await fetch(`${asAdmin.base}/api/nope`, { headers: { 'X-Forwarded-For': '192.0.2.14' } })).status, 404);
    assert.equal(asAdmin.security.isBanned('192.0.2.14'), false);
    const asMember = await serve(options, signedIn);
    for (let i = 0; i < 2; i++) await fetch(`${asMember.base}/api/nope`, { headers: { 'X-Forwarded-For': '192.0.2.15' } });
    assert.equal(asMember.security.isBanned('192.0.2.15'), true);
  });

  it('still turns an administrator away from a blocked address', async () => {
    const { base } = await serve({ ip: { burst: 1, perMinute: 1 }, ban: { violations: 2, authFailures: 1000, notFound: 1000, windowMs: 60_000, durationMs: 60_000 } }, admin);
    const from = { headers: { 'X-Forwarded-For': '192.0.2.16' } };
    // Static files stay under the per-IP limit, so scanning them earns a block.
    for (let i = 0; i < 3; i++) await fetch(`${base}/somewhere`, from);
    const res = await fetch(`${base}/api/things`, from);
    assert.equal(res.status, 403);
  });

  it('refuses new live connections once the server is full', async () => {
    const { base } = await serve({ streamsTotal: 0 }, signedIn);
    const full = await fetch(`${base}/api/events`);
    assert.deepEqual([full.status, await full.json()], [503, { error: 'Too many live connections. Try again later.' }]);
  });
});
