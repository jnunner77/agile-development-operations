import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { Caller } from '#application/caller.ts';
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
    assert.throws(() => trustFunction('not-an-address'), /TRUST_PROXY/);
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
      team: { all: async () => [{ id: 'm2', name: 'Bo', username: 'bo', email: '', color: '#0078d4', active: true }] },
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
