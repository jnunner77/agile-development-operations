import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { BackupExport } from '#application/backups/export-backup.ts';
import type { Caller } from '#application/caller.ts';
import type { SnapshotMeta } from '#domain/snapshots/snapshot.ts';
import { emptyDatabase } from '#infrastructure/json-store/schema.ts';
import { httpFailure } from '#presentation/http/errors.ts';
import { JSON_LIMIT_BYTES } from '#presentation/http/body.ts';
import { parseReset, parseSnapshotDetails } from '#presentation/backups/parsers.ts';
import { backupRoutes, type BackupRouteDeps } from '#presentation/backups/routes.ts';
import { err, ok } from '#shared/result.ts';

let caller: Caller = { name: 'Ann', memberId: 'm1', mayModerateComments: false, admin: 'granted', origin: undefined };
let heavyAllowed = true;
let calls: { name: string; input: unknown }[] = [];
/** The order things happened in: the rate limit notes whether the body had been read yet. */
let steps: string[] = [];

const meta: SnapshotMeta = {
  id: 'snap-1',
  name: 'Baseline',
  description: '',
  kind: 'manual',
  createdAt: '2026-03-02T10:00:00.000Z',
  createdBy: 'Ann',
  sizeBytes: 2,
  stats: { workItems: 0, sprints: 0, members: 0 },
};
const replaced = { safetySnapshot: { ...meta, kind: 'pre-import' as const } };
const exported: BackupExport = {
  fileName: 'fabrikam-backup-2026-03-02-10-00-00.json',
  file: { format: 'ado-clone-backup', exportedAt: '2026-03-02T10:00:00.000Z', exportedBy: 'Ann', data: emptyDatabase() },
};

function record<I>(name: string) {
  return (input: I) => {
    calls.push({ name, input });
    steps.push(name);
  };
}

const fakes: BackupRouteDeps = {
  identify: () => caller,
  heavyOperation: (req, res) => {
    steps.push(req.readableFlowing === null ? 'heavy, body unread' : 'heavy, body read');
    if (!heavyAllowed) res.writeHead(429, { 'Content-Type': 'application/json' }).end('{"error":"Too many backup and snapshot operations."}');
    return heavyAllowed;
  },
  listSnapshots: { execute: async () => [meta] },
  takeSnapshot: { execute: async (input) => (record('take')(input), ok(meta)) },
  updateSnapshot: { execute: async (input) => (record('update')(input), ok(meta)) },
  deleteSnapshot: { execute: async (input) => (record('delete')(input), input.id === 'missing' ? err({ code: 'SNAPSHOT_NOT_FOUND', id: 'missing' }) : ok(undefined)) },
  restoreSnapshot: { execute: async (input) => (record('restore')(input), ok(replaced)) },
  downloadSnapshot: { execute: async (input) => (record('download')(input), ok({ fileName: 'snapshot-snap-1.json', contents: new TextEncoder().encode('{"format":"ado-clone-snapshot"}') })) },
  exportBackup: { execute: async (input) => (record('export')(input), exported) },
  importBackup: { execute: async (input) => (record('import')(input), ok(replaced)) },
  resetProject: { execute: async (input) => (record('reset')(input), ok(replaced)) },
};

const routes = backupRoutes(fakes);
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
  steps = [];
  heavyAllowed = true;
  caller = { ...caller, admin: 'granted' };
});

async function call(method: string, path: string, body?: string) {
  const res = await fetch(`${base}${path}`, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body }) });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text.startsWith('{') || text.startsWith('[') ? JSON.parse(text) : text };
}

describe('snapshot and backup routes', () => {
  it('route every endpoint to its use case', async () => {
    const cases: [string, string, string | undefined, string | null, number][] = [
      ['GET', '/snapshots', undefined, null, 200],
      ['POST', '/snapshots', undefined, 'take', 201],
      ['POST', '/snapshots', '{"name":"Baseline","description":"d"}', 'take', 201],
      ['PATCH', '/snapshots/snap-1', '{"name":"New"}', 'update', 200],
      ['DELETE', '/snapshots/snap-1', undefined, 'delete', 204],
      ['POST', '/snapshots/snap-1/restore', undefined, 'restore', 200],
      ['GET', '/snapshots/snap-1/download', undefined, 'download', 200],
      ['GET', '/backup/export', undefined, 'export', 200],
      ['POST', '/backup/import', '{"workItems":[]}', 'import', 200],
      ['POST', '/backup/reset', '{"mode":"demo"}', 'reset', 200],
    ];
    for (const [method, path, body, name, status] of cases) {
      calls = [];
      const res = await call(method, path, body);
      assert.equal(res.status, status, `${method} ${path}`);
      assert.equal(calls[0]?.name, name ?? undefined, `${method} ${path}`);
    }
  });

  it('pass on what was sent', async () => {
    await call('PATCH', '/snapshots/snap-1', '{"description":"Before go-live"}');
    await call('POST', '/backup/reset', '{"mode":"empty"}');
    await call('POST', '/backup/import', '{"workItems":[],"sprints":[]}');
    await call('POST', '/snapshots');
    assert.deepEqual(
      calls.map((c) => c.input),
      [
        { caller, id: 'snap-1', name: undefined, description: 'Before go-live' },
        { caller, mode: 'empty' },
        { caller, file: { workItems: [], sprints: [] } },
        { caller, name: undefined, description: undefined },
      ],
    );
  });

  it('send downloads and exports as attachments', async () => {
    const download = await call('GET', '/snapshots/snap-1/download');
    assert.equal(download.headers.get('content-disposition'), 'attachment; filename="snapshot-snap-1.json"');
    assert.match(download.headers.get('content-type') ?? '', /^application\/json/);
    assert.deepEqual(download.body, { format: 'ado-clone-snapshot' });
    const backup = await call('GET', '/backup/export');
    assert.equal(backup.headers.get('content-disposition'), 'attachment; filename="fabrikam-backup-2026-03-02-10-00-00.json"');
    assert.equal(backup.body.format, 'ado-clone-backup');
  });

  it('check access, then the rate limit, before reading the body', async () => {
    caller = { ...caller, admin: 'not-admin' };
    for (const [method, path] of [
      ['PATCH', '/snapshots/snap-1'],
      ['DELETE', '/snapshots/snap-1'],
      ['POST', '/snapshots/snap-1/restore'],
      ['POST', '/backup/import'],
      ['POST', '/backup/reset'],
    ] as const) {
      steps = [];
      const res = await call(method, path, '{"mode":"demo"}');
      assert.deepEqual([res.status, res.body], [403, { error: 'Only administrators can do this' }], `${method} ${path}`);
      assert.deepEqual(steps, [], `${method} ${path}`);
    }
    assert.deepEqual(calls, []);

    caller = { ...caller, admin: 'granted' };
    heavyAllowed = false;
    for (const [method, path] of [
      ['POST', '/snapshots'],
      ['POST', '/snapshots/snap-1/restore'],
      ['GET', '/snapshots/snap-1/download'],
      ['GET', '/backup/export'],
      ['POST', '/backup/import'],
      ['POST', '/backup/reset'],
    ] as const) {
      steps = [];
      assert.equal((await call(method, path, method === 'POST' ? '{"mode":"demo"}' : undefined)).status, 429, `${method} ${path}`);
      assert.deepEqual(steps, ['heavy, body unread'], `${method} ${path}`);
    }
    assert.deepEqual(calls, []);
    // Renaming and deleting aren't expensive.
    assert.equal((await call('PATCH', '/snapshots/snap-1', '{"name":"x"}')).status, 200);

    heavyAllowed = true;
    steps = [];
    await call('POST', '/backup/reset', '{"mode":"demo"}');
    assert.deepEqual(steps, ['heavy, body unread', 'reset']);
  });

  it('accept a large body only for an administrator import', async () => {
    const big = JSON.stringify({ workItems: [], padding: 'x'.repeat(JSON_LIMIT_BYTES + 10) });
    assert.equal((await call('POST', '/backup/import', big)).status, 200);
    assert.equal((await call('POST', '/snapshots', big)).status, 413);
    const malformed = await call('POST', '/backup/import', '{');
    assert.deepEqual([malformed.status, malformed.body], [400, { error: 'Malformed JSON' }]);
  });

  it('answer use case errors', async () => {
    assert.deepEqual((await call('DELETE', '/snapshots/missing')).body, { error: 'Snapshot not found' });
  });
});

describe('backup parsers and errors', () => {
  it('read request bodies strictly', () => {
    assert.deepEqual(parseSnapshotDetails({ name: 1 }), { ok: false, error: { code: 'INVALID_REQUEST', message: 'name: Expected text' } });
    assert.deepEqual(parseSnapshotDetails({ bogus: 1 }), { ok: false, error: { code: 'INVALID_REQUEST', message: 'Unrecognized field "bogus"' } });
    assert.equal(parseSnapshotDetails(undefined).ok, false);
    assert.deepEqual(parseReset({ mode: 'all' }), { ok: false, error: { code: 'INVALID_REQUEST', message: 'mode: Expected one of empty, demo' } });
    assert.deepEqual(parseReset({}), { ok: false, error: { code: 'INVALID_REQUEST', message: 'mode: Required' } });
  });

  it('give each error a status and a readable message', () => {
    assert.deepEqual(httpFailure({ code: 'SNAPSHOT_NOT_FOUND', id: 'x' }), { status: 404, message: 'Snapshot not found' });
    assert.deepEqual(httpFailure({ code: 'MANUAL_SNAPSHOT_LIMIT', max: 50 }), {
      status: 400,
      message: 'There are already 50 snapshots taken by hand. An administrator can delete old ones to make room.',
    });
    assert.deepEqual(httpFailure({ code: 'INVALID_BACKUP', reason: 'Backup is not a JSON object' }), { status: 400, message: 'Backup is not a JSON object' });
    assert.deepEqual(httpFailure({ code: 'TEXT_TOO_LONG', field: 'name', max: 200 }), { status: 400, message: 'Name must be at most 200 characters' });
  });
});
