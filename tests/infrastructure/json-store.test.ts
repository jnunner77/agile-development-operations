import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { Delta } from '#application/contracts/database.ts';
import { Link, LinkDraft, type LinkId } from '#domain/links/link.ts';
import { DeletedWorkItem } from '#domain/recycle-bin/deleted-work-item.ts';
import { FieldChanges } from '#domain/work-items/fields.ts';
import { WorkItemAggregate } from '#domain/work-items/work-item.ts';
import { JsonLinkRepository } from '#infrastructure/json-store/link-repository.ts';
import { JsonProjectDirectory } from '#infrastructure/json-store/project-directory.ts';
import { JsonRecycleBinRepository } from '#infrastructure/json-store/recycle-bin-repository.ts';
import { emptyDatabase, normalizeDatabase } from '#infrastructure/json-store/schema.ts';
import { Store } from '#infrastructure/json-store/store.ts';
import { StoreUnitOfWork } from '#infrastructure/json-store/unit-of-work.ts';
import { JsonWorkItemRepository } from '#infrastructure/json-store/work-item-repository.ts';
import { LocalEventBus } from '#infrastructure/local-event-bus.ts';
import { RandomIds } from '#infrastructure/random-ids.ts';
import { SystemClock } from '#infrastructure/system-clock.ts';
import { err, ok } from '#shared/result.ts';

const NOW = new Date('2026-03-02T10:00:00.000Z');
const meta = { actor: 'Ann', origin: 'tab-1' };

let dir: string;
let store: Store;
let uow: StoreUnitOfWork;
let items: JsonWorkItemRepository;
let links: JsonLinkRepository;
let bin: JsonRecycleBinRepository;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boards-infra-'));
  store = new Store(dir, () => emptyDatabase());
  uow = new StoreUnitOfWork(store);
  items = new JsonWorkItemRepository(uow);
  links = new JsonLinkRepository(uow);
  bin = new JsonRecycleBinRepository(uow);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

async function newItem(title: string): Promise<WorkItemAggregate> {
  const fields = FieldChanges.validate({ title });
  assert.ok(fields.ok);
  const created = WorkItemAggregate.create({
    id: await items.nextId(),
    type: 'Bug',
    fields: fields.value,
    parent: undefined,
    defaultAreaPath: 'Fabrikam',
    stackRank: 1000,
    context: { now: NOW, actor: 'Ann', entryId: 'e1' },
  });
  assert.ok(created.ok);
  return created.value;
}

describe('store unit of work', () => {
  it('saves work items, persists them and broadcasts one delta', async () => {
    const seen: { delta: Delta; origin: string | undefined }[] = [];
    store.subscribe((delta, origin) => seen.push({ delta, origin }));
    const result = await uow.run(meta, async () => {
      const item = await newItem('First');
      await items.save(item);
      return ok(item.toSnapshot());
    });
    assert.ok(result.ok);
    assert.equal(result.value.result.id, 1);
    assert.equal(result.value.delta.version, 2);
    assert.deepEqual(result.value.delta.workItems?.map((w) => w.title), ['First']);
    assert.deepEqual(seen.map((s) => s.origin), ['tab-1']);
    // Round trip through disk.
    const reloaded = new Store(dir);
    assert.equal(reloaded.db.workItems[0]?.title, 'First');
    assert.equal(reloaded.db.nextWorkItemId, 2);
  });

  it('round-trips an aggregate unchanged', async () => {
    await uow.run(meta, async () => {
      const item = await newItem('Round trip');
      await items.save(item);
      const loaded = await items.findById(item.id);
      assert.deepEqual(loaded?.toSnapshot(), item.toSnapshot());
      assert.deepEqual(await items.ranks(), [{ id: item.id, stackRank: 1000 }]);
      return ok(undefined);
    });
  });

  it('discards everything, including used ids, when the work returns an error', async () => {
    const before = store.db;
    const result = await uow.run(meta, async () => {
      await items.save(await newItem('Doomed'));
      return err({ code: 'NOPE' });
    });
    assert.deepEqual(result, { ok: false, error: { code: 'NOPE' } });
    assert.equal(store.db, before);
    assert.equal(store.db.nextWorkItemId, 1);
    assert.equal(new Store(dir).db.workItems.length, 0);
  });

  it('discards everything when the work throws', async () => {
    await assert.rejects(
      uow.run(meta, async () => {
        await items.save(await newItem('Doomed'));
        throw new Error('boom');
      }),
      /boom/,
    );
    assert.equal(store.db.workItems.length, 0);
    // The store still works afterwards.
    assert.ok((await uow.run(meta, async () => ok(undefined))).ok);
  });

  it('runs units of work one at a time', async () => {
    const order: string[] = [];
    const slow = uow.run(meta, async () => {
      order.push('a start');
      await new Promise((r) => setTimeout(r, 20));
      await items.save(await newItem('A'));
      order.push('a end');
      return ok(undefined);
    });
    const fast = uow.run(meta, async () => {
      order.push('b start');
      await items.save(await newItem('B'));
      return ok(undefined);
    });
    await Promise.all([slow, fast]);
    assert.deepEqual(order, ['a start', 'a end', 'b start']);
    assert.deepEqual(store.db.workItems.map((w) => [w.id, w.title]), [
      [1, 'A'],
      [2, 'B'],
    ]);
  });

  it('refuses to overwrite a change committed while it was running', async () => {
    let started: () => void = () => {};
    const running = new Promise<void>((r) => (started = r));
    const result = uow.run(meta, async () => {
      started();
      await new Promise((r) => setTimeout(r, 10));
      return ok(undefined);
    });
    await running;
    store.transact('Bo', undefined, (tx) => tx.db.settings.projectName = 'Changed');
    await assert.rejects(result, /changed while an asynchronous transaction/);
    assert.equal(store.db.settings.projectName, 'Changed');
  });

  it('refuses repository use outside a unit of work, and nesting', async () => {
    await assert.rejects(items.findAll(), /outside a unit of work/);
    await assert.rejects(
      uow.run(meta, async () => uow.run(meta, async () => ok(undefined))),
      /cannot be nested/,
    );
  });
});

describe('store repositories', () => {
  it('stores links and the recycle bin, reporting them in the delta', async () => {
    const result = await uow.run(meta, async () => {
      const a = await newItem('A');
      const b = await newItem('B');
      await items.save(a);
      await items.save(b);
      const draft = LinkDraft.of({ sourceId: a.id, targetId: b.id, type: 'Related' });
      assert.ok(draft.ok);
      const link = Link.create(draft.value, { id: 'l1' as LinkId, existing: [], actor: 'Ann', now: NOW });
      assert.ok(link.ok);
      await links.save(link.value);
      assert.deepEqual((await links.findByItem(b.id)).map((l) => l.id), ['l1']);
      await items.delete(a.id);
      await bin.add(DeletedWorkItem.of({ item: a, links: [link.value], now: NOW, actor: 'Ann' }));
      await links.delete(link.value.id);
      assert.equal((await bin.findById(a.id))?.id, a.id);
      assert.equal(await links.findById('l1' as LinkId), undefined);
      return ok(undefined);
    });
    assert.ok(result.ok);
    const { delta } = result.value;
    assert.deepEqual(delta.deletedWorkItemIds, [1]);
    assert.deepEqual(delta.workItems?.map((w) => w.id), [2]);
    assert.deepEqual(delta.deletedLinkIds, ['l1']);
    assert.equal(delta.links, undefined);
    assert.equal(delta.recycleBin?.length, 1);
    assert.equal(store.db.recycleBin[0]?.links[0]?.id, 'l1');
  });

  it('answers project lookups from the running unit of work', async () => {
    store.transact('Ann', undefined, (tx) => {
      tx.db.members.push({ id: 'm1', name: 'Ann', username: '', email: '', color: '#000', active: true });
      tx.db.sprints.push({ id: 's1', name: 'Sprint 1', startDate: null, finishDate: null, goal: '' });
      tx.db.settings.areaPaths = [];
    });
    const project = new JsonProjectDirectory(uow);
    await uow.run(meta, async () => {
      assert.equal(await project.memberExists('m1'), true);
      assert.equal(await project.memberExists('m2'), false);
      assert.equal(await project.sprintExists('s1'), true);
      assert.equal(await project.defaultAreaPath(), 'Fabrikam');
      return ok(undefined);
    });
  });

  it('throws on corrupt stored data rather than guessing', async () => {
    store.transact('Ann', undefined, (tx) => {
      tx.db.links.push({ id: 'bad', sourceId: 1, targetId: 2, type: 'Blocks' as 'Related', comment: '', createdBy: 'x', createdAt: NOW.toISOString() });
    });
    await assert.rejects(uow.run(meta, async () => ok(await links.findById('bad' as LinkId))), /unknown type/);
  });
});

describe('loading stored data', () => {
  it('fills in fields that deleted items were stored without', async () => {
    const old = { id: 5, type: 'Bug', title: 'Old', history: [], comments: [] };
    const db = normalizeDatabase({ workItems: [], sprints: [], members: [], recycleBin: [{ item: old, deletedAt: NOW.toISOString(), deletedBy: 'Ann' }] });
    const entry = db.recycleBin[0];
    assert.ok(entry);
    assert.deepEqual([entry.item.devLinks, entry.item.hyperlinks, entry.links], [[], [], []]);
    assert.equal(DeletedWorkItem.reconstitute(entry).id, 5);
  });
});

describe('small adapters', () => {
  it('clock, ids and the event bus', async () => {
    const before = Date.now();
    assert.ok(new SystemClock().now().getTime() >= before);
    const ids = new RandomIds();
    assert.notEqual(ids.next(), ids.next());
    const bus = new LocalEventBus();
    const seen: string[] = [];
    const stop = bus.subscribe((e) => seen.push(e.type));
    await bus.publish([{ type: 'WorkItemRestored', workItemId: 1, occurredAt: NOW }]);
    stop();
    await bus.publish([{ type: 'WorkItemRestored', workItemId: 1, occurredAt: NOW }]);
    assert.deepEqual(seen, ['WorkItemRestored']);
  });
});
