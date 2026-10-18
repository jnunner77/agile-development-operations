import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { Delta } from '#application/contracts/database.ts';
import { Snapshot, SnapshotDetails, newSnapshotId, type SnapshotKind } from '#domain/snapshots/snapshot.ts';
import { emptyDatabase } from '#infrastructure/json-store/schema.ts';
import { Store } from '#infrastructure/json-store/store.ts';
import { StoreProject } from '#infrastructure/json-store/store-project.ts';
import { runEvery } from '#infrastructure/scheduler.ts';
import { FileSnapshotRepository } from '#infrastructure/snapshots/snapshot-files.ts';
import { ok } from '#shared/result.ts';

const NOW = new Date('2026-03-02T10:00:00.000Z');
let dir: string;
let store: Store;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boards-backups-'));
  store = new Store(dir, () => emptyDatabase({ projectName: 'Fabrikam' }));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function snapshot(kind: SnapshotKind, at: Date, name = ''): Snapshot {
  const taken = Snapshot.take({ id: newSnapshotId(at, kind), kind, name, description: '', createdBy: 'Ann', stats: { workItems: 0, sprints: 0, members: 0 }, sizeBytes: 2, now: at }, []);
  assert.ok(taken.ok);
  return taken.value;
}

describe('snapshot files', () => {
  it('keeps the existing layout: a file per snapshot and an index, newest first', async () => {
    const repo = new FileSnapshotRepository(dir);
    const project = new StoreProject(store);
    const older = snapshot('manual', NOW, 'Older');
    const newer = snapshot('auto', new Date(NOW.getTime() + 1000));
    await repo.add(older, project.capture());
    await repo.add(newer, project.capture());
    const index = JSON.parse(fs.readFileSync(path.join(dir, 'snapshots', 'index.json'), 'utf8'));
    assert.deepEqual(index.map((m: { id: string }) => m.id), [newer.id, older.id]);
    const file = JSON.parse(fs.readFileSync(path.join(dir, 'snapshots', `${older.id}.json`), 'utf8'));
    assert.equal(file.format, 'ado-clone-snapshot');
    assert.deepEqual(file.meta, older.toMeta());
    assert.deepEqual(file.data, store.db);
    assert.deepEqual(await repo.data(older.id), { data: store.db });
    const streamed: Uint8Array[] = [];
    for await (const chunk of (await repo.file(older.id)) ?? []) streamed.push(chunk);
    assert.deepEqual(JSON.parse(Buffer.concat(streamed).toString('utf8')), file);
  });

  it('updates and deletes, and leaves out entries whose file is gone or that are damaged', async () => {
    const repo = new FileSnapshotRepository(dir);
    const project = new StoreProject(store);
    const a = snapshot('manual', NOW, 'A');
    const b = snapshot('manual', new Date(NOW.getTime() + 1), 'B');
    await repo.add(a, project.capture());
    await repo.add(b, project.capture());
    const found = await repo.find(a.id);
    assert.ok(found);
    const details = SnapshotDetails.validate({ name: 'Renamed' });
    assert.ok(details.ok);
    found.update(details.value, NOW);
    await repo.update(found);
    assert.equal((await repo.find(a.id))?.name, 'Renamed');
    await repo.delete(b.id);
    assert.equal(fs.existsSync(path.join(dir, 'snapshots', `${b.id}.json`)), false);
    assert.deepEqual((await repo.all()).map((s) => s.name), ['Renamed']);

    fs.rmSync(path.join(dir, 'snapshots', `${a.id}.json`));
    assert.deepEqual(await repo.all(), []);
    assert.equal(await repo.data(a.id), undefined);
    fs.writeFileSync(path.join(dir, 'snapshots', 'index.json'), JSON.stringify([{ id: '../db' }, 'junk']));
    assert.deepEqual(await repo.all(), []);
  });
});

describe('the project over the JSON store', () => {
  it('captures the database, serializing it only when asked', () => {
    const copy = new StoreProject(store).capture();
    assert.equal(copy.data, store.db);
    assert.equal(copy.json, JSON.stringify(store.db));
    assert.equal(copy.sizeBytes, Buffer.byteLength(JSON.stringify(store.db)));
  });

  it('reads backups in any of their forms, or says what is wrong', () => {
    const project = new StoreProject(store);
    const db = emptyDatabase({ projectName: 'Imported' });
    for (const raw of [db, { format: 'ado-clone-backup', data: db }, { format: 'ado-clone-snapshot', meta: {}, data: db }]) {
      const parsed = project.parse(raw);
      assert.ok(parsed.ok);
      assert.equal(parsed.value.settings.projectName, 'Imported');
    }
    assert.deepEqual(project.parse({ nope: true }), { ok: false, error: { code: 'INVALID_BACKUP', reason: 'Backup is missing the "workItems" list' } });
    assert.deepEqual(project.parse(undefined), { ok: false, error: { code: 'INVALID_BACKUP', reason: 'Backup is not a JSON object' } });
  });

  it('replaces the project and tells browsers to reload', () => {
    const project = new StoreProject(store);
    const seen: Delta[] = [];
    store.subscribe((delta) => seen.push(delta));
    const before = store.db.version;
    project.replace(project.blank({ ...store.db.settings, teamName: 'New team' }), 'tab-1');
    assert.equal(store.db.settings.teamName, 'New team');
    assert.deepEqual(seen, [{ version: before + 1, reset: true }]);
    assert.ok(project.demo().workItems.length > 10);
  });

  it('runs exclusively: no change commits while it runs', async () => {
    const project = new StoreProject(store);
    const order: string[] = [];
    let release = () => {};
    const exclusive = project.exclusive(async () => {
      order.push('exclusive start');
      await new Promise<void>((resolve) => (release = resolve));
      order.push('exclusive end');
    });
    const change = store.transactAsync('Ann', undefined, async () => {
      order.push('change');
      return ok(undefined);
    });
    await new Promise((r) => setTimeout(r, 10));
    release();
    await Promise.all([exclusive, change]);
    assert.deepEqual(order, ['exclusive start', 'exclusive end', 'change']);
  });
});

describe('the scheduler', () => {
  it('runs now and then every interval, reporting failures without stopping', async () => {
    let runs = 0;
    const errors: unknown[] = [];
    const stop = runEvery(
      5,
      async () => {
        runs++;
        if (runs === 2) throw new Error('disk full');
      },
      (error) => errors.push(error),
    );
    assert.equal(runs, 1);
    await new Promise((r) => setTimeout(r, 40));
    stop();
    const after = runs;
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(after >= 3, `ran ${after} times`);
    assert.equal(runs, after);
    assert.equal(errors.length, 1);
  });
});
