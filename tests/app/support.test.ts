import assert from 'node:assert/strict';
import http from 'node:http';
import { describe, it, mock } from 'node:test';
import { equals, expect } from './support/expect.ts';
import request from './support/request.ts';

// The helpers stand in for vitest and supertest; a lenient one would hide real failures.

const fails = (check: () => void, pattern?: RegExp) => assert.throws(check, pattern ?? /expected/);

describe('expect', () => {
  it('passes what should pass', () => {
    expect(1).toBe(1);
    expect({ a: 1, b: [1, { c: 2 }], gone: undefined }).toEqual({ b: [1, { c: 2 }], a: 1 });
    expect({ a: 1, b: { c: 2, d: 3 } }).toMatchObject({ b: { c: 2 } });
    expect([1, 2]).toHaveLength(2);
    expect('Ignored event "issues"').toMatch(/Ignored/);
    expect('abc').toMatch('b');
    expect([1, 2]).toContain(2);
    expect('abc').not.toContain('z');
    expect(null).toBeNull();
    expect(undefined).toBeUndefined();
    expect(0).toBeDefined();
    expect(2).toBeLessThanOrEqual(2);
    expect({ a: 1 }).not.toHaveProperty('b');
    expect(() => {
      throw new Error('ENOSPC: full');
    }).toThrow(/ENOSPC/);
    const fn = mock.fn();
    expect(fn).not.toHaveBeenCalled();
    fn();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('fails what should fail', () => {
    fails(() => expect(1).toBe(2));
    fails(() => expect({}).toBe({}));
    fails(() => expect({ a: 1 }).toEqual({ a: 2 }));
    fails(() => expect({ a: 1 }).toEqual({ a: 1, b: 2 }));
    fails(() => expect([1, 2]).toEqual([1, 2, 3]));
    fails(() => expect({ a: { c: 2 } }).toMatchObject({ a: { c: 3 } }));
    fails(() => expect([{ a: 1 }, { a: 2 }]).toMatchObject([{ a: 1 }]));
    fails(() => expect([1]).toHaveLength(2));
    fails(() => expect('abc').toMatch(/z/));
    fails(() => expect(5).toMatch(/5/));
    fails(() => expect([1]).toContain(2));
    fails(() => expect('abc').not.toContain('b'));
    fails(() => expect(undefined).toBeNull());
    fails(() => expect(null).toBeUndefined());
    fails(() => expect(undefined).toBeDefined());
    fails(() => expect(0).toBeTruthy());
    fails(() => expect(3).toBeLessThanOrEqual(2));
    fails(() => expect(() => undefined).toThrow());
    fails(() => expect(() => {
      throw new Error('EIO');
    }).toThrow(/ENOSPC/));
    fails(() => expect(1).not.toBe(1));
    fails(() => expect(mock.fn()).toHaveBeenCalled());
    assert.throws(() => expect(1, 'the status').toBe(2), { message: 'the status: expected 1 to be 2' });
    assert.equal(equals(new Date(1), new Date(1)), true);
    assert.equal(equals(new Date(1), new Date(2)), false);
  });
});

describe('request', () => {
  it('sends JSON and headers, reads JSON back, and keeps an agent signed in', async () => {
    const seen: { method: string | undefined; type: string | undefined; cookie: string | undefined; body: string }[] = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d: Buffer) => (body += d.toString()));
      req.on('end', () => {
        seen.push({ method: req.method, type: req.headers['content-type'], cookie: req.headers.cookie, body });
        if (req.url === '/login') res.setHeader('Set-Cookie', 'session=abc; Path=/; HttpOnly');
        if (req.url === '/logout') res.setHeader('Set-Cookie', 'session=; Path=/; Max-Age=0');
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ path: req.url, user: req.headers['x-user'] ?? null }));
      });
    });
    const sent = await request(server).post('/things').set('X-User', 'Ann').send({ a: 1 });
    assert.deepEqual([sent.status, sent.body], [200, { path: '/things', user: 'Ann' }]);
    assert.deepEqual(seen[0], { method: 'POST', type: 'application/json', cookie: undefined, body: '{"a":1}' });
    await request(server).post('/raw').send('a=1');
    assert.equal(seen[1]?.type, 'application/x-www-form-urlencoded');

    const agent = request.agent(server);
    await agent.post('/login').send({});
    await agent.get('/me');
    assert.equal(seen[3]?.cookie, 'session=abc');
    assert.equal(request(agent).get, agent.get);
    await agent.post('/logout').send({});
    await agent.get('/me');
    assert.equal(seen[5]?.cookie, undefined);
    server.close();
  });
});
