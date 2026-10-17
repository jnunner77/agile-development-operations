import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AddComment } from '#application/work-items/add-comment.ts';
import { AddHyperlink } from '#application/work-items/add-hyperlink.ts';
import { AddLink } from '#application/work-items/add-link.ts';
import { BulkUpdateWorkItems } from '#application/work-items/bulk-update-work-items.ts';
import { CopyWorkItem } from '#application/work-items/copy-work-item.ts';
import { CreateWorkItem } from '#application/work-items/create-work-item.ts';
import { DeleteComment } from '#application/work-items/delete-comment.ts';
import { DeleteWorkItem } from '#application/work-items/delete-work-item.ts';
import { DeleteWorkItems } from '#application/work-items/delete-work-items.ts';
import { EditComment } from '#application/work-items/edit-comment.ts';
import { MoveWorkItem } from '#application/work-items/move-work-item.ts';
import { PurgeWorkItem } from '#application/work-items/purge-work-item.ts';
import { RemoveHyperlink } from '#application/work-items/remove-hyperlink.ts';
import { RemoveLink } from '#application/work-items/remove-link.ts';
import { RestoreWorkItem } from '#application/work-items/restore-work-item.ts';
import { UpdateWorkItem } from '#application/work-items/update-work-item.ts';
import type { MemberId } from '#domain/team/member.ts';
import { NOW, admin, ann, bo, setup, unwrap } from './fixtures.ts';

describe('creating work items', () => {
  it('assigns sequential ids, records the creator and publishes once committed', async () => {
    const t = setup();
    const result = unwrap(await new CreateWorkItem(t.deps).execute({ caller: ann, type: 'Product Backlog Item', fields: { title: 'First', effort: 3 } }));
    assert.equal(result.result.id, 1);
    assert.deepEqual(result.delta, { version: 1 });
    assert.equal(t.item(1).createdBy, 'Ann');
    assert.equal(t.item(1).createdAt, NOW.toISOString());
    assert.deepEqual(t.published, [{ type: 'WorkItemCreated', workItemId: 1, workItemType: 'Product Backlog Item', occurredAt: NOW }]);
    assert.deepEqual(t.unitOfWork.runs, [{ meta: { actor: 'Ann', origin: 'tab-1' }, committed: true }]);
    assert.equal((await t.create('Bug')).id, 2);
  });

  it('puts new items at the bottom, or the top when asked', async () => {
    const t = setup();
    await t.create('Epic');
    await t.create('Epic');
    const top = unwrap(await new CreateWorkItem(t.deps).execute({ caller: ann, type: 'Bug', fields: { title: 'Top' }, position: 'top' }));
    const order = t.items.rows().sort((a, b) => a.stackRank - b.stackRank).map((w) => w.id);
    assert.deepEqual(order, [top.result.id, 1, 2]);
  });

  it('refuses bad input before touching anything', async () => {
    const t = setup();
    const create = new CreateWorkItem(t.deps);
    assert.deepEqual(await create.execute({ caller: ann, type: 'Story', fields: { title: 'x' } }), { ok: false, error: { code: 'UNKNOWN_WORK_ITEM_TYPE', type: 'Story' } });
    assert.deepEqual(await create.execute({ caller: ann, type: 'Task', fields: { title: '  ' } }), { ok: false, error: { code: 'TITLE_REQUIRED' } });
    assert.deepEqual(await create.execute({ caller: ann, type: 'Task', fields: {} }), { ok: false, error: { code: 'TITLE_REQUIRED' } });
    assert.equal(t.unitOfWork.runs.length, 0);
  });

  it('persists and publishes nothing when a reference is missing, and keeps ids sequential', async () => {
    const t = setup();
    const create = new CreateWorkItem(t.deps);
    assert.deepEqual(await create.execute({ caller: ann, type: 'Task', fields: { title: 'x', iterationId: 'nope' } }), {
      ok: false,
      error: { code: 'SPRINT_NOT_FOUND', id: 'nope' },
    });
    assert.deepEqual(await create.execute({ caller: ann, type: 'Task', fields: { title: 'x', assignedTo: 'nobody' } }), {
      ok: false,
      error: { code: 'MEMBER_NOT_FOUND', id: 'nobody' },
    });
    assert.deepEqual(await create.execute({ caller: ann, type: 'Task', fields: { title: 'x', parentId: 42 } }), {
      ok: false,
      error: { code: 'WORK_ITEM_NOT_FOUND', id: 42 },
    });
    assert.deepEqual(t.items.rows(), []);
    assert.deepEqual(t.published, []);
    assert.equal((await t.create('Task')).id, 1);
  });

  it('enforces the parent hierarchy', async () => {
    const t = setup();
    const epic = await t.create('Epic');
    assert.deepEqual(await new CreateWorkItem(t.deps).execute({ caller: ann, type: 'Task', fields: { title: 'x', parentId: epic.id } }), {
      ok: false,
      error: { code: 'PARENT_TYPE_NOT_ALLOWED', parentType: 'Epic', childType: 'Task' },
    });
    const pbi = await t.create('Product Backlog Item', { iterationId: 's1' });
    const task = await t.create('Task', { parentId: pbi.id });
    assert.equal(task.iterationId, 's1');
  });
});

describe('changing work items', () => {
  it('records changes and leaves child tasks where they are', async () => {
    const t = setup();
    const pbi = await t.create('Product Backlog Item', { iterationId: 's1' });
    const task = await t.create('Task', { parentId: pbi.id });
    const result = unwrap(await new UpdateWorkItem(t.deps).execute({ caller: bo, id: pbi.id, changes: { state: 'Committed', iterationId: 's2' } }));
    assert.equal(result.result.reason, 'Commitment made by the team');
    assert.equal(result.result.changedBy, 'Bo');
    assert.equal(t.item(task.id).iterationId, 's1');
  });

  it('refuses unknown items, states and references without changing anything', async () => {
    const t = setup();
    const task = await t.create('Task');
    const update = new UpdateWorkItem(t.deps);
    assert.deepEqual(await update.execute({ caller: ann, id: 999, changes: { title: 'x' } }), { ok: false, error: { code: 'WORK_ITEM_NOT_FOUND', id: 999 } });
    assert.deepEqual(await update.execute({ caller: ann, id: task.id, changes: { title: 'Renamed', state: 'Committed' } }), {
      ok: false,
      error: { code: 'INVALID_STATE', state: 'Committed', type: 'Task' },
    });
    assert.deepEqual(await update.execute({ caller: ann, id: task.id, changes: { parentId: task.id } }), { ok: false, error: { code: 'SELF_PARENT' } });
    assert.equal(t.item(task.id).title, 'Task item');
    assert.equal(t.published.length, 1);
  });

  it('moves open child tasks with their parent when it is dragged to another sprint', async () => {
    const t = setup();
    const pbi = await t.create('Product Backlog Item', { iterationId: 's1' });
    const open = await t.create('Task', { parentId: pbi.id });
    const done = await t.create('Task', { parentId: pbi.id, state: 'Done' });
    unwrap(await new MoveWorkItem(t.deps).execute({ caller: ann, id: pbi.id, iterationId: 's2' }));
    assert.equal(t.item(pbi.id).iterationId, 's2');
    assert.equal(t.item(open.id).iterationId, 's2');
    assert.equal(t.item(done.id).iterationId, 's1');
    assert.equal(t.item(open.id).history.length, 2);
  });

  it('reorders relative to neighbours and renumbers when ranks get too close', async () => {
    const t = setup();
    const [a, b, c] = [await t.create('Bug'), await t.create('Bug'), await t.create('Bug')];
    const move = new MoveWorkItem(t.deps);
    const order = () => t.items.rows().sort((x, y) => x.stackRank - y.stackRank).map((w) => w.id);
    unwrap(await move.execute({ caller: ann, id: c.id, beforeId: a.id }));
    assert.deepEqual(order(), [c.id, a.id, b.id]);
    for (let i = 0; i < 60; i++) unwrap(await move.execute({ caller: ann, id: b.id, afterId: c.id, beforeId: a.id }));
    assert.deepEqual(order(), [c.id, b.id, a.id]);
    assert.ok(t.items.rows().every((w) => Number.isInteger(w.stackRank / 1000) || w.id === b.id));
  });

  it('undoes the field changes of a move whose neighbour is missing', async () => {
    const t = setup();
    const bug = await t.create('Bug');
    assert.deepEqual(await new MoveWorkItem(t.deps).execute({ caller: ann, id: bug.id, state: 'Approved', afterId: 77 }), {
      ok: false,
      error: { code: 'WORK_ITEM_NOT_FOUND', id: 77 },
    });
    assert.equal(t.item(bug.id).state, 'New');
    assert.equal(t.unitOfWork.runs.at(-1)?.committed, false);
  });
});

describe('bulk edits', () => {
  it('edits several items, adding and removing tags', async () => {
    const t = setup();
    const a = await t.create('Product Backlog Item', { tags: ['Web'] });
    const b = await t.create('Bug', { tags: ['web', 'Urgent'] });
    const task = await t.create('Task');
    const bulk = new BulkUpdateWorkItems(t.deps);
    unwrap(await bulk.execute({ caller: ann, ids: [a.id, b.id, task.id], changes: { state: 'Approved' }, addTags: ['Q3', 'Web'] }));
    assert.equal(t.item(a.id).state, 'Approved');
    // A state the type doesn't have is skipped for that item.
    assert.equal(t.item(task.id).state, 'To Do');
    assert.deepEqual(t.item(b.id).tags, ['web', 'Urgent', 'Q3']);
    unwrap(await bulk.execute({ caller: ann, ids: [a.id], changes: {}, removeTags: ['WEB'] }));
    assert.deepEqual(t.item(a.id).tags, ['Q3']);
  });

  it('changes nothing when any item would break the tag limit', async () => {
    const t = setup();
    const a = await t.create('Epic');
    const b = await t.create('Epic', { tags: ['x'] });
    const tags = Array.from({ length: 100 }, (_, i) => `t${i}`);
    assert.deepEqual(await new BulkUpdateWorkItems(t.deps).execute({ caller: ann, ids: [a.id, b.id], changes: { priority: 1 }, addTags: tags }), {
      ok: false,
      error: { code: 'ITEM_TAG_LIMIT', id: b.id, max: 100 },
    });
    assert.equal(t.item(a.id).priority, 2);
    assert.deepEqual(t.item(a.id).tags, []);
  });
});

describe('deleting and restoring', () => {
  it('orphans children, removes links and keeps the item in the recycle bin', async () => {
    const t = setup();
    const parent = await t.create('Product Backlog Item');
    const child = await t.create('Task', { parentId: parent.id });
    const other = await t.create('Bug');
    unwrap(await new AddLink(t.deps).execute({ caller: ann, sourceId: parent.id, targetId: other.id, type: 'Related' }));
    unwrap(await new DeleteWorkItem(t.deps).execute({ caller: bo, id: parent.id }));
    assert.equal(t.item(child.id).parentId, null);
    assert.equal(t.item(child.id).history.at(-1)?.note, `Parent #${parent.id} was deleted`);
    assert.deepEqual(t.links.rows(), []);
    assert.equal(t.recycleBin.rows()[0]?.deletedBy, 'Bo');
    assert.ok(!t.items.rows().some((w) => w.id === parent.id));

    const restored = unwrap(await new RestoreWorkItem(t.deps).execute({ caller: ann, id: parent.id }));
    assert.equal(restored.result.history.at(-1)?.note, 'Restored from recycle bin');
    assert.equal(t.links.rows().length, 1);
    assert.deepEqual(t.recycleBin.rows(), []);
    assert.deepEqual(await new RestoreWorkItem(t.deps).execute({ caller: ann, id: parent.id }), {
      ok: false,
      error: { code: 'DELETED_WORK_ITEM_NOT_FOUND', id: parent.id },
    });
  });

  it('restores without references to things deleted since', async () => {
    const t = setup();
    const pbi = await t.create('Product Backlog Item');
    const task = await t.create('Task', { parentId: pbi.id, iterationId: 's1', assignedTo: 'm2' });
    unwrap(await new DeleteWorkItem(t.deps).execute({ caller: ann, id: task.id }));
    unwrap(await new DeleteWorkItem(t.deps).execute({ caller: ann, id: pbi.id }));
    await t.members.delete('m2' as MemberId);
    const restored = unwrap(await new RestoreWorkItem(t.deps).execute({ caller: ann, id: task.id })).result;
    assert.equal(restored.parentId, null);
    assert.equal(restored.iterationId, 's1');
    assert.equal(restored.assignedTo, null);
  });

  it('deletes several items, skipping missing ones, and purges for good', async () => {
    const t = setup();
    const a = await t.create('Epic');
    const b = await t.create('Epic');
    unwrap(await new DeleteWorkItems(t.deps).execute({ caller: ann, ids: [a.id, 999, b.id] }));
    assert.deepEqual(t.items.rows(), []);
    unwrap(await new PurgeWorkItem(t.deps).execute({ caller: ann, id: a.id }));
    assert.deepEqual(t.recycleBin.rows().map((r) => r.item.id), [b.id]);
    assert.deepEqual(await new PurgeWorkItem(t.deps).execute({ caller: ann, id: a.id }), { ok: false, error: { code: 'DELETED_WORK_ITEM_NOT_FOUND', id: a.id } });
    assert.deepEqual(t.published.filter((e) => e.type === 'WorkItemPurged').length, 1);
  });
});

describe('copying', () => {
  it('copies an item and its children right after the originals, linked to the source', async () => {
    const t = setup();
    const pbi = await t.create('Product Backlog Item', { effort: 8, tags: ['x'] });
    const task = await t.create('Task', { parentId: pbi.id, originalEstimate: 3 });
    const after = await t.create('Bug');
    const copy = unwrap(await new CopyWorkItem(t.deps).execute({ caller: ann, id: pbi.id, includeChildren: true })).result;
    assert.equal(copy.title, 'Copy of Product Backlog Item item');
    assert.equal(copy.effort, 8);
    assert.equal(copy.history.at(-1)?.note, `Added Related link to #${pbi.id}`);
    const children = t.items.rows().filter((w) => w.parentId === copy.id);
    assert.equal(children.length, 1);
    assert.equal(children[0]?.title, 'Task item');
    assert.deepEqual(t.links.rows().map((l) => [l.sourceId, l.targetId, l.comment]), [[copy.id, pbi.id, 'Copied from']]);
    const order = t.items.rows().sort((a, b) => a.stackRank - b.stackRank).map((w) => w.id);
    assert.deepEqual(order, [pbi.id, copy.id, task.id, children[0]?.id, after.id]);
  });

  it('renumbers repeated copies of an item and its children without losing their order', async () => {
    const t = setup();
    const pbi = await t.create('Product Backlog Item');
    const task = await t.create('Task', { parentId: pbi.id });
    const after = await t.create('Bug');
    const copies: number[] = [];
    const childCopies: number[] = [];
    const copy = new CopyWorkItem(t.deps);

    for (let i = 0; i < 60; i++) {
      const result = unwrap(await copy.execute({ caller: ann, id: pbi.id, includeChildren: true })).result;
      copies.push(result.id);
      childCopies.push(t.items.rows().find((item) => item.parentId === result.id)!.id);
    }

    const order = t.items.rows().sort((a, b) => a.stackRank - b.stackRank).map((w) => w.id);
    assert.deepEqual(order, [pbi.id, ...copies.toReversed(), task.id, ...childCopies.toReversed(), after.id]);
    assert.equal(new Set(t.items.rows().map((item) => item.stackRank)).size, t.items.rows().length);
  });
});

describe('links', () => {
  it('adds links with notes on both items and refuses duplicates', async () => {
    const t = setup();
    const a = await t.create('Product Backlog Item');
    const b = await t.create('Product Backlog Item');
    const add = new AddLink(t.deps);
    const link = unwrap(await add.execute({ caller: ann, sourceId: a.id, targetId: b.id, type: 'Predecessor' })).result;
    assert.equal(t.item(b.id).history.at(-1)?.note, `Added Successor link to #${a.id}`);
    assert.deepEqual(await add.execute({ caller: ann, sourceId: b.id, targetId: a.id, type: 'Successor' }), {
      ok: false,
      error: { code: 'LINK_DUPLICATE', targetId: a.id, type: 'Successor' },
    });
    assert.deepEqual(await add.execute({ caller: ann, sourceId: a.id, targetId: 99, type: 'Related' }), { ok: false, error: { code: 'WORK_ITEM_NOT_FOUND', id: 99 } });
    unwrap(await new RemoveLink(t.deps).execute({ caller: ann, linkId: link.id }));
    assert.deepEqual(t.links.rows(), []);
    assert.equal(t.item(a.id).history.at(-1)?.note, `Removed link to #${b.id}`);
    assert.deepEqual(await new RemoveLink(t.deps).execute({ caller: ann, linkId: link.id }), { ok: false, error: { code: 'LINK_NOT_FOUND', id: link.id } });
  });
});

describe('comments and hyperlinks', () => {
  it('attributes comments and lets only the author or a moderator change them', async () => {
    const t = setup();
    const w = await t.create('Bug');
    const c = unwrap(await new AddComment(t.deps).execute({ caller: ann, workItemId: w.id, text: '<p>Hi</p>' })).result;
    assert.deepEqual([c.author, c.authorId], ['Ann', 'm1']);
    assert.deepEqual(await new EditComment(t.deps).execute({ caller: bo, workItemId: w.id, commentId: c.id, text: 'x' }), {
      ok: false,
      error: { code: 'COMMENT_FORBIDDEN' },
    });
    unwrap(await new EditComment(t.deps).execute({ caller: ann, workItemId: w.id, commentId: c.id, text: 'Edited' }));
    assert.equal(t.item(w.id).comments[0]?.text, 'Edited');
    unwrap(await new DeleteComment(t.deps).execute({ caller: admin, workItemId: w.id, commentId: c.id }));
    assert.deepEqual(t.item(w.id).comments, []);
    assert.deepEqual(await new AddComment(t.deps).execute({ caller: ann, workItemId: w.id, text: '  ' }), { ok: false, error: { code: 'COMMENT_EMPTY' } });
  });

  it('adds and removes http(s) hyperlinks', async () => {
    const t = setup();
    const w = await t.create('Bug');
    assert.deepEqual(await new AddHyperlink(t.deps).execute({ caller: ann, workItemId: w.id, url: 'javascript:alert(1)' }), {
      ok: false,
      error: { code: 'HYPERLINK_NOT_HTTP' },
    });
    const h = unwrap(await new AddHyperlink(t.deps).execute({ caller: ann, workItemId: w.id, url: 'https://example.com', comment: 'spec' })).result;
    unwrap(await new RemoveHyperlink(t.deps).execute({ caller: ann, workItemId: w.id, hyperlinkId: h.id }));
    assert.deepEqual(t.item(w.id).hyperlinks, []);
    assert.deepEqual(await new RemoveHyperlink(t.deps).execute({ caller: ann, workItemId: w.id, hyperlinkId: h.id }), {
      ok: false,
      error: { code: 'HYPERLINK_NOT_FOUND', id: h.id },
    });
  });
});
