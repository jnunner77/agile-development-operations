import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../server/app';
import { emptyDatabase } from '../server/schema';
import { SnapshotManager } from '../server/snapshots';
import { Store } from '../server/store';
import { buildDemoDatabase } from '../server/seed';
import type { Delta, WorkItem } from '../shared/types';

let dir: string;
let store: Store;
let snapshots: SnapshotManager;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boards-test-'));
  store = new Store(dir, () => emptyDatabase());
  snapshots = new SnapshotManager(store);
  app = createApp({ store, snapshots });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

async function create(type: string, fields: Record<string, unknown> = {}) {
  const res = await request(app)
    .post('/api/workitems')
    .set('X-User', 'Tester')
    .send({ type, title: `${type} item`, ...fields });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.result as WorkItem;
}

async function sprint(name: string, startDate = '2026-01-05', finishDate = '2026-01-16') {
  const res = await request(app).post('/api/sprints').send({ name, startDate, finishDate });
  expect(res.status).toBe(201);
  return res.body.result as { id: string };
}

const item = (id: number) => store.db.workItems.find((w) => w.id === id)!;

describe('work items', () => {
  it('creates items with sequential ids, history and a delta', async () => {
    const res = await request(app).post('/api/workitems').set('X-User', 'Tester').send({ type: 'Product Backlog Item', title: 'First', effort: 3, tags: ['a', 'A', ' b '] });
    expect(res.status).toBe(201);
    const delta = res.body.delta as Delta;
    expect(delta.workItems?.[0].id).toBe(1);
    const w = item(1);
    expect(w.state).toBe('New');
    expect(w.createdBy).toBe('Tester');
    expect(w.tags).toEqual(['a', 'b']);
    expect(w.history[0].note).toBe('Created');
    expect((await create('Bug')).id).toBe(2);
  });

  it('validates input', async () => {
    expect((await request(app).post('/api/workitems').send({ type: 'Task', title: '  ' })).status).toBe(400);
    expect((await request(app).post('/api/workitems').send({ type: 'Story', title: 'x' })).status).toBe(400);
    const w = await create('Task');
    expect((await request(app).patch(`/api/workitems/${w.id}`).send({ state: 'Committed' })).body.error).toMatch(/not a valid state/);
    expect((await request(app).patch(`/api/workitems/${w.id}`).send({ dueDate: '2026-02-30' })).status).toBe(400);
    expect((await request(app).patch(`/api/workitems/${w.id}`).send({ bogus: 1 })).status).toBe(400);
    expect((await request(app).patch('/api/workitems/999').send({ title: 'x' })).status).toBe(404);
  });

  it('records field changes, reason and closed date', async () => {
    const w = await create('Product Backlog Item');
    await request(app).patch(`/api/workitems/${w.id}`).set('X-User', 'Ann').send({ state: 'Committed', effort: 5, title: 'Renamed' });
    const after = item(w.id);
    expect(after.reason).toBe('Commitment made by the team');
    const last = after.history[after.history.length - 1];
    expect(last.changedBy).toBe('Ann');
    expect(last.changes.map((c) => c.field).sort()).toEqual(['effort', 'reason', 'state', 'title']);
    await request(app).patch(`/api/workitems/${w.id}`).send({ state: 'Done' });
    expect(item(w.id).closedAt).not.toBeNull();
    await request(app).patch(`/api/workitems/${w.id}`).send({ state: 'Committed' });
    expect(item(w.id).closedAt).toBeNull();
  });

  it('zeroes remaining work when a task is done', async () => {
    const t = await create('Task', { originalEstimate: 6 });
    expect(item(t.id).remainingWork).toBe(6);
    await request(app).patch(`/api/workitems/${t.id}`).send({ state: 'Done' });
    expect(item(t.id).remainingWork).toBe(0);
  });

  it('enforces the parent hierarchy and prevents cycles', async () => {
    const epic = await create('Epic');
    const feature = await create('Feature', { parentId: epic.id });
    const pbi = await create('Product Backlog Item', { parentId: feature.id });
    const task = await create('Task', { parentId: pbi.id });
    expect((await request(app).patch(`/api/workitems/${task.id}`).send({ parentId: epic.id })).status).toBe(400);
    expect((await request(app).patch(`/api/workitems/${pbi.id}`).send({ parentId: pbi.id })).status).toBe(400);
    const epic2 = await create('Epic');
    expect((await request(app).patch(`/api/workitems/${feature.id}`).send({ parentId: epic2.id })).status).toBe(200);
  });

  it('tasks inherit the parent sprint and follow it when the parent moves', async () => {
    const s1 = await sprint('Sprint 1');
    const s2 = await sprint('Sprint 2', '2026-01-19', '2026-01-30');
    const pbi = await create('Product Backlog Item', { iterationId: s1.id });
    const open = await create('Task', { parentId: pbi.id });
    const done = await create('Task', { parentId: pbi.id, state: 'Done' });
    expect(item(open.id).iterationId).toBe(s1.id);
    await request(app).post(`/api/workitems/${pbi.id}/move`).send({ iterationId: s2.id });
    expect(item(pbi.id).iterationId).toBe(s2.id);
    expect(item(open.id).iterationId).toBe(s2.id);
    expect(item(done.id).iterationId).toBe(s1.id);
    await request(app).post('/api/workitems/bulk').send({ ids: [pbi.id], changes: { iterationId: null } });
    expect(item(pbi.id).iterationId).toBeNull();
    expect(item(open.id).iterationId).toBeNull();
  });

  it('reorders by stack rank relative to neighbours', async () => {
    const a = await create('Product Backlog Item');
    const b = await create('Product Backlog Item');
    const c = await create('Product Backlog Item');
    const order = () => [...store.db.workItems].sort((x, y) => x.stackRank - y.stackRank).map((w) => w.id);
    expect(order()).toEqual([a.id, b.id, c.id]);
    await request(app).post(`/api/workitems/${c.id}/move`).send({ beforeId: a.id });
    expect(order()).toEqual([c.id, a.id, b.id]);
    await request(app).post(`/api/workitems/${c.id}/move`).send({ afterId: a.id });
    expect(order()).toEqual([a.id, c.id, b.id]);
    const top = await create('Bug', { position: 'top' });
    expect(order()[0]).toBe(top.id);
    // Repeated halving eventually renumbers without losing order.
    for (let i = 0; i < 60; i++) await request(app).post(`/api/workitems/${b.id}/move`).send({ afterId: a.id, beforeId: c.id });
    expect(order()).toEqual([top.id, a.id, b.id, c.id]);
  });

  it('deletes to the recycle bin and restores with links', async () => {
    const parent = await create('Product Backlog Item');
    const child = await create('Task', { parentId: parent.id });
    const other = await create('Bug');
    await request(app).post('/api/links').send({ sourceId: parent.id, targetId: other.id, type: 'Related' });
    const res = await request(app).delete(`/api/workitems/${parent.id}`);
    expect(res.body.delta.deletedWorkItemIds).toEqual([parent.id]);
    expect(item(child.id).parentId).toBeNull();
    expect(store.db.links).toHaveLength(0);
    expect(store.db.recycleBin).toHaveLength(1);
    await request(app).post(`/api/recycle-bin/${parent.id}/restore`);
    expect(item(parent.id)).toBeDefined();
    expect(store.db.links).toHaveLength(1);
    expect(store.db.recycleBin).toHaveLength(0);
  });

  it('manages links, comments and hyperlinks', async () => {
    const a = await create('Product Backlog Item');
    const b = await create('Product Backlog Item');
    const link = (await request(app).post('/api/links').send({ sourceId: a.id, targetId: b.id, type: 'Predecessor' })).body.result;
    // The reverse direction of an existing link is a duplicate.
    expect((await request(app).post('/api/links').send({ sourceId: b.id, targetId: a.id, type: 'Successor' })).status).toBe(400);
    expect((await request(app).post('/api/links').send({ sourceId: a.id, targetId: a.id, type: 'Related' })).status).toBe(400);
    await request(app).delete(`/api/links/${link.id}`);
    expect(store.db.links).toHaveLength(0);

    const c = (await request(app).post(`/api/workitems/${a.id}/comments`).set('X-User', 'Bo').send({ text: '<p>Hi</p>' })).body.result;
    expect(c.author).toBe('Bo');
    await request(app).patch(`/api/workitems/${a.id}/comments/${c.id}`).send({ text: '<p>Edited</p>' });
    expect(item(a.id).comments[0].editedAt).not.toBeNull();
    await request(app).delete(`/api/workitems/${a.id}/comments/${c.id}`);
    expect(item(a.id).comments).toHaveLength(0);

    expect((await request(app).post(`/api/workitems/${a.id}/hyperlinks`).send({ url: 'javascript:alert(1)' })).status).toBe(400);
    const h = (await request(app).post(`/api/workitems/${a.id}/hyperlinks`).send({ url: 'https://example.com', comment: 'spec' })).body.result;
    await request(app).delete(`/api/workitems/${a.id}/hyperlinks/${h.id}`);
    expect(item(a.id).hyperlinks).toHaveLength(0);
  });

  it('copies an item with its children', async () => {
    const pbi = await create('Product Backlog Item', { effort: 8, tags: ['x'] });
    await create('Task', { parentId: pbi.id, originalEstimate: 3 });
    const copy = (await request(app).post(`/api/workitems/${pbi.id}/copy`).send({ includeChildren: true })).body.result as WorkItem;
    expect(copy.title).toBe(`Copy of ${pbi.title}`);
    expect(copy.effort).toBe(8);
    expect(store.db.workItems.filter((w) => w.parentId === copy.id)).toHaveLength(1);
    expect(store.db.links.some((l) => l.sourceId === copy.id && l.targetId === pbi.id)).toBe(true);
  });
});

describe('sprints, team and capacity', () => {
  it('creates sprints, rejects bad dates and deletes moving work', async () => {
    expect((await request(app).post('/api/sprints').send({ name: 'Bad', startDate: '2026-01-10', finishDate: '2026-01-01' })).status).toBe(400);
    const s1 = await sprint('Sprint 1');
    expect((await request(app).post('/api/sprints').send({ name: 'sprint 1' })).status).toBe(400);
    const s2 = await sprint('Sprint 2', '2026-01-19', '2026-01-30');
    const w = await create('Product Backlog Item', { iterationId: s1.id });
    await request(app).delete(`/api/sprints/${s1.id}?moveTo=${s2.id}`);
    expect(item(w.id).iterationId).toBe(s2.id);
    expect(store.db.capacities.find((c) => c.sprintId === s1.id)).toBeUndefined();
  });

  it('saves capacity, copies it forward and cleans up removed members', async () => {
    const m = (await request(app).post('/api/members').send({ name: 'Ann' })).body.result;
    const s1 = await sprint('Sprint 1');
    const cap = {
      teamDaysOff: [{ start: '2026-01-09', end: '2026-01-09' }],
      members: [{ memberId: m.id, activities: [{ activity: 'Development', capacityPerDay: 6 }], daysOff: [{ start: '2026-01-06', end: '2026-01-07' }] }],
    };
    expect((await request(app).put(`/api/sprints/${s1.id}/capacity`).send(cap)).status).toBe(200);
    expect((await request(app).put(`/api/sprints/${s1.id}/capacity`).send({ ...cap, teamDaysOff: [{ start: '2026-01-09', end: '2026-01-01' }] })).status).toBe(400);
    // New sprints carry activities forward but not days off.
    const s2 = await sprint('Sprint 2', '2026-01-19', '2026-01-30');
    const c2 = store.db.capacities.find((c) => c.sprintId === s2.id)!;
    expect(c2.members[0].activities[0].capacityPerDay).toBe(6);
    expect(c2.members[0].daysOff).toEqual([]);

    const w = await create('Task', { assignedTo: m.id });
    await request(app).delete(`/api/members/${m.id}`);
    expect(item(w.id).assignedTo).toBeNull();
    expect(store.db.capacities.every((c) => c.members.length === 0)).toBe(true);
  });

  it('rejects assigning work to unknown members or sprints', async () => {
    const w = await create('Task');
    expect((await request(app).patch(`/api/workitems/${w.id}`).send({ assignedTo: 'nobody' })).status).toBe(404);
    expect((await request(app).patch(`/api/workitems/${w.id}`).send({ iterationId: 'nope' })).status).toBe(404);
  });

  it('stores member usernames and keeps them unique', async () => {
    const ann = (await request(app).post('/api/members').send({ name: 'Ann', username: ' ann.lee ' })).body.result;
    expect(ann.username).toBe('ann.lee');
    const bob = (await request(app).post('/api/members').send({ name: 'Bob' })).body.result;
    expect(bob.username).toBe('');
    // Duplicates are rejected regardless of case, on create and on update.
    expect((await request(app).post('/api/members').send({ name: 'Other', username: 'ANN.LEE' })).status).toBe(400);
    expect((await request(app).patch(`/api/members/${bob.id}`).send({ username: 'Ann.Lee' })).status).toBe(400);
    expect((await request(app).post('/api/members').send({ name: 'Bad', username: 'has space' })).status).toBe(400);
    // Saving a member with its own username is fine; several members may leave it blank.
    expect((await request(app).patch(`/api/members/${ann.id}`).send({ name: 'Ann Lee', username: 'ann.lee' })).status).toBe(200);
    expect((await request(app).post('/api/members').send({ name: 'Cy', username: '' })).status).toBe(201);
  });
});

describe('snapshots and backups', () => {
  it('takes, restores and deletes snapshots with a safety copy', async () => {
    await create('Epic', { title: 'Before' });
    const snap = (await request(app).post('/api/snapshots').set('X-User', 'Ann').send({ name: 'Baseline' })).body;
    expect(snap.stats.workItems).toBe(1);
    await create('Epic', { title: 'After' });
    const res = await request(app).post(`/api/snapshots/${snap.id}/restore`);
    expect(res.status).toBe(200);
    expect(store.db.workItems.map((w) => w.title)).toEqual(['Before']);
    const list = (await request(app).get('/api/snapshots')).body as { kind: string; stats: { workItems: number } }[];
    expect(list.map((s) => s.kind)).toEqual(['pre-restore', 'manual']);
    expect(list[0].stats.workItems).toBe(2);
    // New ids continue after the restored data.
    expect((await create('Task')).id).toBe(2);
    expect((await request(app).delete(`/api/snapshots/${snap.id}`)).status).toBe(204);
    expect((await request(app).get(`/api/snapshots/../db`)).status).toBe(404);
  });

  it('exports and imports a backup', async () => {
    await create('Feature', { title: 'Keep me' });
    const exported = (await request(app).get('/api/backup/export')).body;
    expect(exported.format).toBe('ado-clone-backup');
    await request(app).post('/api/backup/reset').send({ mode: 'empty' });
    expect(store.db.workItems).toHaveLength(0);
    expect((await request(app).post('/api/backup/import').send({ nope: true })).status).toBe(400);
    expect((await request(app).post('/api/backup/import').send(exported)).status).toBe(200);
    expect(store.db.workItems[0].title).toBe('Keep me');
  });

  it('takes automatic snapshots on schedule and prunes old ones', async () => {
    store.db.settings.backup = { autoEnabled: true, intervalHours: 1, retain: 2 };
    const t0 = Date.now();
    expect(snapshots.tick(t0)).toBeDefined();
    expect(snapshots.tick(t0 + 1000)).toBeUndefined();
    expect(snapshots.tick(t0 + 3_700_000)).toBeDefined();
    await request(app).post('/api/snapshots').send({ name: 'Manual' });
    snapshots.create('', '', 'auto', 'System');
    snapshots.create('', '', 'auto', 'System');
    const list = snapshots.list();
    expect(list.filter((s) => s.kind === 'auto')).toHaveLength(2);
    expect(list.filter((s) => s.kind === 'manual')).toHaveLength(1);
    store.db.settings.backup.autoEnabled = false;
    expect(snapshots.tick(t0 + 99_000_000)).toBeUndefined();
  });

  it('persists to disk and reloads', async () => {
    await create('Epic', { title: 'Persisted' });
    const reloaded = new Store(dir);
    expect(reloaded.db.workItems[0].title).toBe('Persisted');
  });
});

describe('demo data', () => {
  it('builds a consistent demo project', () => {
    const db = buildDemoDatabase('2026-09-26');
    const ids = new Set(db.workItems.map((w) => w.id));
    expect(db.workItems.every((w) => w.parentId == null || ids.has(w.parentId))).toBe(true);
    expect(db.sprints).toHaveLength(5);
    expect(db.nextWorkItemId).toBe(Math.max(...ids) + 1);
    for (const w of db.workItems) {
      const times = w.history.map((h) => h.changedAt);
      expect([...times].sort()).toEqual(times);
    }
  });
});
