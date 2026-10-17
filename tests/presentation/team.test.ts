import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { Caller } from '#application/caller.ts';
import type { Committed } from '#application/ports.ts';
import type { UpdateSettingsInput } from '#application/settings/update-settings.ts';
import type { CopyCapacityInput } from '#application/sprints/copy-capacity.ts';
import type { CreateSprintInput } from '#application/sprints/create-sprint.ts';
import type { DeleteSprintInput } from '#application/sprints/delete-sprint.ts';
import type { SetCapacityInput } from '#application/sprints/set-capacity.ts';
import type { UpdateSprintInput } from '#application/sprints/update-sprint.ts';
import type { CreateMemberInput } from '#application/team/create-member.ts';
import type { DeleteMemberInput } from '#application/team/delete-member.ts';
import type { UpdateMemberInput } from '#application/team/update-member.ts';
import type { Member, Settings, Sprint, SprintCapacity } from '#domain/types.ts';
import { DEFAULT_TEST_SETTINGS } from '#infrastructure/memory/settings-repository.ts';
import { httpFailure } from '#presentation/http/errors.ts';
import { parseCapacity, parseSettings, parseSprint } from '#presentation/team/parsers.ts';
import { teamRoutes, type TeamRouteDeps } from '#presentation/team/routes.ts';
import { ok, type Result } from '#shared/result.ts';

let caller: Caller = { name: 'Ann', memberId: 'm1', mayModerateComments: false, admin: 'granted', origin: undefined };
const delta = { version: 3 };
const sprint: Sprint = { id: 's1', name: 'Sprint 1', startDate: null, finishDate: null, goal: '' };
const capacity: SprintCapacity = { sprintId: 's1', teamDaysOff: [], members: [] };
const member: Member = { id: 'm1', name: 'Ann', username: '', email: '', color: '#0078d4', active: true };
const settings: Settings = DEFAULT_TEST_SETTINGS;

let calls: { name: string; input: unknown }[] = [];

function succeeds<I, O>(name: string, result: O) {
  return {
    execute: async (input: I): Promise<Result<Committed<O>, never>> => {
      calls.push({ name, input });
      return ok({ result, delta });
    },
  };
}

const routes = teamRoutes({
  identify: () => caller,
  createSprint: succeeds<CreateSprintInput, Sprint>('createSprint', sprint),
  updateSprint: succeeds<UpdateSprintInput, Sprint>('updateSprint', sprint),
  deleteSprint: succeeds<DeleteSprintInput, void>('deleteSprint', undefined),
  setCapacity: succeeds<SetCapacityInput, SprintCapacity>('setCapacity', capacity),
  copyCapacity: succeeds<CopyCapacityInput, SprintCapacity>('copyCapacity', capacity),
  createMember: succeeds<CreateMemberInput, Member>('createMember', member),
  updateMember: succeeds<UpdateMemberInput, Member>('updateMember', member),
  deleteMember: succeeds<DeleteMemberInput, void>('deleteMember', undefined),
  updateSettings: succeeds<UpdateSettingsInput, Settings>('updateSettings', settings),
} satisfies TeamRouteDeps);

let server: http.Server;
let base: string;

before(async () => {
  server = http.createServer((req, res) => {
    void routes.handle(req, res).then((handled) => {
      if (!handled) res.writeHead(404).end('not mine');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  base = `http://127.0.0.1:${address.port}`;
});

after(() => {
  server.close();
});

beforeEach(() => {
  calls = [];
  caller = { ...caller, admin: 'granted' };
});

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text.startsWith('{') ? JSON.parse(text) : text };
}

describe('team routes', () => {
  it('route every endpoint to its use case', async () => {
    const cases: [string, string, unknown, string, number][] = [
      ['POST', '/sprints', { name: 'S' }, 'createSprint', 201],
      ['PATCH', '/sprints/s1', { goal: 'g' }, 'updateSprint', 200],
      ['DELETE', '/sprints/s1', undefined, 'deleteSprint', 200],
      ['PUT', '/sprints/s1/capacity', { teamDaysOff: [], members: [] }, 'setCapacity', 200],
      ['POST', '/sprints/s1/capacity/copy', { fromSprintId: 's0' }, 'copyCapacity', 200],
      ['POST', '/members', { name: 'Eve' }, 'createMember', 201],
      ['PATCH', '/members/m1', { active: false }, 'updateMember', 200],
      ['DELETE', '/members/m1', undefined, 'deleteMember', 200],
      ['PATCH', '/settings', { teamName: 'T' }, 'updateSettings', 200],
    ];
    for (const [method, path, body, name, status] of cases) {
      calls = [];
      const res = await call(method, path, body);
      assert.equal(res.status, status, `${method} ${path}`);
      assert.equal(calls[0]?.name, name, `${method} ${path}`);
    }
  });

  it('read where deleted work goes from the query string', async () => {
    await call('DELETE', '/sprints/s1?moveTo=s2');
    assert.deepEqual(calls[0]?.input, { caller, id: 's1', moveTo: 's2' });
    calls = [];
    await call('DELETE', '/sprints/s1?moveTo=s2&moveTo=s3');
    assert.deepEqual(calls[0]?.input, { caller, id: 's1', moveTo: null });
  });

  it('turn away non-administrators before reading their request', async () => {
    caller = { ...caller, admin: 'token' };
    assert.deepEqual(await call('POST', '/members', { name: 'x', mode: 'empty' }), {
      status: 403,
      body: { error: "API tokens can't be used to administer the project" },
    });
    caller = { ...caller, admin: 'not-admin' };
    assert.deepEqual(await call('PATCH', '/settings', { nope: 1 }), { status: 403, body: { error: 'Only administrators can do this' } });
    assert.deepEqual(calls, []);
    // Sprints are open to everyone.
    assert.equal((await call('POST', '/sprints', { name: 'S' })).status, 201);
  });
});

describe('team request parsing', () => {
  it('checks shapes and types', () => {
    assert.deepEqual(parseSprint({ name: 'S', bogus: 1 }), { ok: false, error: { code: 'INVALID_REQUEST', message: 'Unrecognized field "bogus"' } });
    assert.deepEqual(parseSprint({ startDate: 5 }), { ok: false, error: { code: 'INVALID_REQUEST', message: 'startDate: Expected text' } });
    assert.deepEqual(parseCapacity({ teamDaysOff: [{ start: '2026-01-01' }], members: [] }), {
      ok: false,
      error: { code: 'INVALID_REQUEST', message: 'end: Required' },
    });
    assert.equal(parseCapacity({ teamDaysOff: [] }).ok, false);
    assert.deepEqual(parseSettings({ backup: { autoEnabled: true, intervalHours: 1 } }), { ok: false, error: { code: 'INVALID_REQUEST', message: 'retain: Required' } });
  });
});

describe('team error mapping', () => {
  it('keeps the messages people saw before', () => {
    assert.deepEqual(httpFailure({ code: 'SPRINT_NAME_TAKEN', name: 'S' }), { status: 400, message: 'A sprint named "S" already exists' });
    assert.deepEqual(httpFailure({ code: 'TEXT_TOO_LONG', field: 'username', max: 64 }), { status: 400, message: 'Username must be 64 characters or fewer' });
    assert.deepEqual(httpFailure({ code: 'ADMIN_ONLY', reason: 'not-admin' }), { status: 403, message: 'Only administrators can do this' });
    assert.equal(httpFailure({ code: 'LAST_ADMIN' }).status, 400);
  });
});
