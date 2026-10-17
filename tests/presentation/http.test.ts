import assert from 'node:assert/strict';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { readJsonBody } from '#presentation/http/body.ts';
import { sendJson } from '#presentation/http/respond.ts';
import { Router } from '#presentation/http/router.ts';

let server: http.Server;
let base: string;
let handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;

before(async () => {
  server = http.createServer((req, res) => {
    handler(req, res).catch((e: unknown) => sendJson(res, 500, { error: String(e) }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  base = `http://127.0.0.1:${address.port}`;
});

after(() => {
  server.close();
});

describe('router', () => {
  const seen: string[] = [];
  const router = new Router()
    .add('GET', '/items/:id', async (_req, res, params) => {
      seen.push(params['id'] ?? '');
      sendJson(res, 200, params);
    })
    .add('POST', '/items', async (_req, res) => sendJson(res, 201, {}));

  it('matches like the rest of the API: any case, optional trailing slash, decoded params', async () => {
    handler = async (req, res) => {
      if (!(await router.handle(req, res))) sendJson(res, 404, { next: true });
    };
    assert.deepEqual(await (await fetch(`${base}/items/a%20b?x=1`)).json(), { id: 'a b' });
    assert.equal((await fetch(`${base}/ITEMS/7/`)).status, 200);
    assert.equal((await fetch(`${base}/items`, { method: 'POST' })).status, 201);
    assert.deepEqual(await (await fetch(`${base}/items/7/more`)).json(), { next: true });
    assert.deepEqual(await (await fetch(`${base}/items/7`, { method: 'DELETE' })).json(), { next: true });
  });

  it('says which requests it owns', () => {
    assert.equal(router.owns('GET', '/items/1'), true);
    assert.equal(router.owns('GET', '/Items/1/'), true);
    assert.equal(router.owns('PUT', '/items/1'), false);
    assert.equal(router.owns('GET', '/other'), false);
  });
});

describe('reading JSON bodies', () => {
  const post = (body: string | undefined, headers: Record<string, string> = { 'Content-Type': 'application/json' }) => {
    handler = async (req, res) => sendJson(res, 200, await readJsonBody(req, 64));
    return fetch(`${base}/`, { method: 'POST', headers, ...(body === undefined ? {} : { body }) }).then((r) => r.json());
  };

  it('parses JSON objects and arrays', async () => {
    assert.deepEqual(await post('{"a":1}'), { ok: true, value: { a: 1 } });
    assert.deepEqual(await post('[1]', { 'Content-Type': 'application/json; charset=utf-8' }), { ok: true, value: [1] });
  });

  it('treats an empty JSON body as {} and other content types as no body', async () => {
    assert.deepEqual(await post(''), { ok: true, value: {} });
    assert.deepEqual(await post('{"a":1}', { 'Content-Type': 'text/plain' }), { ok: true });
  });

  it('refuses malformed JSON, bare values and oversized bodies', async () => {
    assert.deepEqual(await post('{oops'), { ok: false, error: { code: 'MALFORMED_JSON' } });
    assert.deepEqual(await post('"text"'), { ok: false, error: { code: 'MALFORMED_JSON' } });
    assert.deepEqual(await post(JSON.stringify({ a: 'x'.repeat(100) })), { ok: false, error: { code: 'BODY_TOO_LARGE' } });
  });
});
