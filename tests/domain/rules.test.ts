import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bulkChangesFor } from '#domain/work-items/bulk.ts';
import { copiedFields, copyTitle } from '#domain/work-items/copy.ts';
import { checkParent, tasksFollowingParent } from '#domain/work-items/hierarchy.ts';
import type { WorkItemId } from '#domain/work-items/ids.ts';
import { bottomRank, needsRenumbering, rankBetween, renumbered, topRank } from '#domain/work-items/ranking.ts';
import type { WorkItemAggregate } from '#domain/work-items/work-item.ts';
import { changes, id, newItem } from './fixtures.ts';

const lookup = (items: WorkItemAggregate[]) => ({ findById: async (i: WorkItemId) => items.find((w) => w.id === i) });

describe('hierarchy', () => {
  const epic = newItem('Epic', {}, { id: 1 });
  const feature = newItem('Feature', { parentId: 1 }, { id: 2, parent: epic });
  const pbi = newItem('Product Backlog Item', { parentId: 2 }, { id: 3, parent: feature });
  const items = lookup([epic, feature, pbi]);

  it('accepts an allowed parent and returns it', async () => {
    assert.deepEqual(await checkParent({ id: 9, type: 'Task' }, id(3), items), { ok: true, value: pbi });
    assert.deepEqual(await checkParent({ id: 9, type: 'Task' }, null, items), { ok: true, value: undefined });
  });

  it('refuses a missing parent, itself, the wrong type, or a cycle', async () => {
    assert.deepEqual(await checkParent({ id: 9, type: 'Task' }, id(99), items), { ok: false, error: { code: 'WORK_ITEM_NOT_FOUND', id: 99 } });
    assert.deepEqual(await checkParent({ id: 3, type: 'Product Backlog Item' }, id(3), items), { ok: false, error: { code: 'SELF_PARENT' } });
    assert.deepEqual(await checkParent({ id: 9, type: 'Task' }, id(1), items), {
      ok: false,
      error: { code: 'PARENT_TYPE_NOT_ALLOWED', parentType: 'Epic', childType: 'Task' },
    });
    // Data that already holds a cycle is caught rather than looping forever.
    const a = newItem('Feature', { parentId: 2 }, { id: 1 });
    const cyclic = lookup([a, newItem('Epic', { parentId: 1 }, { id: 2 })]);
    assert.deepEqual(await checkParent({ id: 9, type: 'Product Backlog Item' }, id(1), cyclic), { ok: false, error: { code: 'CIRCULAR_HIERARCHY' } });
  });

  it('moves open tasks that were in the parent sprint along with it', () => {
    const open = newItem('Task', { iterationId: 's1' }, { id: 4 });
    const done = newItem('Task', { iterationId: 's1', state: 'Done' }, { id: 5 });
    const elsewhere = newItem('Task', { iterationId: 's2' }, { id: 6 });
    const bug = newItem('Bug', { iterationId: 's1' }, { id: 7 });
    assert.deepEqual(tasksFollowingParent([open, done, elsewhere, bug], 's1'), [open]);
  });
});

describe('ranking', () => {
  const r = (n: number, stackRank: number) => ({ id: id(n), stackRank });
  const ranks = [r(1, 1000), r(2, 2000), r(3, 3000)];

  it('places new items at the top or bottom', () => {
    assert.equal(topRank(ranks), 0);
    assert.equal(bottomRank(ranks), 4000);
    assert.equal(topRank([]), 1000);
    assert.equal(bottomRank([]), 1000);
  });

  it('places an item between its neighbours', () => {
    assert.deepEqual(rankBetween(ranks, id(3), null, id(1), 3000), { ok: true, value: 0 });
    assert.deepEqual(rankBetween(ranks, id(3), id(1), null, 3000), { ok: true, value: 1500 });
    assert.deepEqual(rankBetween(ranks, id(1), id(3), null, 1000), { ok: true, value: 4000 });
    assert.deepEqual(rankBetween(ranks, id(3), id(1), id(2), 3000), { ok: true, value: 1500 });
    assert.deepEqual(rankBetween(ranks, id(3), null, null, 3000), { ok: true, value: 3000 });
    assert.deepEqual(rankBetween(ranks, id(3), id(9), null, 3000), { ok: false, error: { code: 'WORK_ITEM_NOT_FOUND', id: 9 } });
    assert.deepEqual(rankBetween(ranks, id(3), null, id(9), 3000), { ok: false, error: { code: 'WORK_ITEM_NOT_FOUND', id: 9 } });
  });

  it('renumbers once neighbours get too close', () => {
    assert.equal(needsRenumbering(ranks), false);
    const close = [r(1, 1000), r(2, 1000.0000001), r(3, 5000)];
    assert.equal(needsRenumbering(close), true);
    assert.deepEqual([...renumbered(close)], [
      [2, 2000],
      [3, 3000],
    ]);
  });
});

describe('bulk edits', () => {
  it('skip a state or parent that does not fit the item', () => {
    const task = newItem('Task');
    const c = changes({ state: 'Approved', parentId: 1, priority: 1 });
    assert.deepEqual(bulkChangesFor(task, c, 'Epic').values, { priority: 1 });
    assert.deepEqual(bulkChangesFor(newItem('Bug'), c, 'Feature').values, { state: 'Approved', parentId: 1, priority: 1 });
  });
});

describe('copying', () => {
  it('names the copy and keeps planning fields', () => {
    assert.equal(copyTitle('Login'), 'Copy of Login');
    assert.equal(copyTitle('x'.repeat(255)).length, 255);
    const source = newItem('Product Backlog Item', { effort: 8, tags: ['x'], state: 'Committed', completedWork: 3 });
    const fields = copiedFields(source, 'Copy', 7);
    assert.equal(fields.effort, 8);
    assert.deepEqual(fields.tags, ['x']);
    assert.equal(fields.parentId, 7);
    assert.equal(fields.state, undefined);
    assert.equal(fields.completedWork, undefined);
  });
});
