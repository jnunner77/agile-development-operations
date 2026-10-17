import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Link, LinkDraft, toLinkId, type LinkId } from '#domain/links/link.ts';
import { DeletedWorkItem } from '#domain/recycle-bin/deleted-work-item.ts';
import { LATER, NOW, ctx, id, newItem } from './fixtures.ts';

const linkId = (s: string) => s as LinkId;

function draft(sourceId: number, targetId: number, type: string, comment?: string) {
  const r = LinkDraft.of({ sourceId: id(sourceId), targetId: id(targetId), type, comment });
  assert.ok(r.ok, JSON.stringify(r));
  return r.value;
}

function link(n: string, sourceId: number, targetId: number, type: string) {
  const r = Link.create(draft(sourceId, targetId, type), { id: linkId(n), existing: [], actor: 'Ann', now: NOW });
  assert.ok(r.ok);
  return r.value;
}

describe('links', () => {
  it('checks the request before looking anything up', () => {
    assert.deepEqual(LinkDraft.of({ sourceId: id(1), targetId: id(1), type: 'Related' }), { ok: false, error: { code: 'LINK_TO_SELF' } });
    assert.deepEqual(LinkDraft.of({ sourceId: id(1), targetId: id(2), type: 'Blocks' }), { ok: false, error: { code: 'UNKNOWN_LINK_TYPE', type: 'Blocks' } });
    assert.deepEqual(LinkDraft.of({ sourceId: id(1), targetId: id(2), type: 'Related', comment: 'x'.repeat(1001) }), {
      ok: false,
      error: { code: 'TEXT_TOO_LONG', field: 'comment', max: 1000 },
    });
  });

  it('creates a link with an event and notes for both ends', () => {
    const l = link('l1', 1, 2, 'Predecessor');
    assert.deepEqual(l.toSnapshot(), { id: 'l1', sourceId: 1, targetId: 2, type: 'Predecessor', comment: '', createdBy: 'Ann', createdAt: NOW.toISOString() });
    assert.deepEqual(l.historyNotes('added'), [
      { itemId: 1, note: 'Added Predecessor link to #2' },
      { itemId: 2, note: 'Added Successor link to #1' },
    ]);
    assert.deepEqual(l.historyNotes('removed'), [
      { itemId: 1, note: 'Removed link to #2' },
      { itemId: 2, note: 'Removed link to #1' },
    ]);
    assert.deepEqual(l.pullEvents(), [{ type: 'LinkAdded', linkId: 'l1', sourceId: 1, targetId: 2, linkType: 'Predecessor', occurredAt: NOW }]);
    l.remove(LATER);
    assert.deepEqual(l.pullEvents(), [{ type: 'LinkRemoved', linkId: 'l1', occurredAt: LATER }]);
  });

  it('refuses a duplicate in either direction', () => {
    const existing = [link('l1', 1, 2, 'Predecessor')];
    const create = (d: LinkDraft) => Link.create(d, { id: linkId('l2'), existing, actor: 'Ann', now: NOW });
    assert.deepEqual(create(draft(2, 1, 'Successor')), { ok: false, error: { code: 'LINK_DUPLICATE', targetId: 1, type: 'Successor' } });
    assert.deepEqual(create(draft(1, 2, 'Predecessor')), { ok: false, error: { code: 'LINK_DUPLICATE', targetId: 2, type: 'Predecessor' } });
    assert.ok(create(draft(1, 2, 'Related')).ok);
  });

  it('treats an impossible id as not found', () => {
    assert.deepEqual(toLinkId(''), { ok: false, error: { code: 'LINK_NOT_FOUND', id: '' } });
    assert.ok(toLinkId('5c0e').ok);
  });
});

describe('recycle bin', () => {
  it('keeps the item with its links and restores what still connects', () => {
    const item = newItem('Task', { parentId: 3, iterationId: 's1' }, { id: 1 });
    const links = [link('l1', 1, 2, 'Related'), link('l2', 4, 1, 'Tests')];
    const deleted = DeletedWorkItem.of({ item, links, now: LATER, actor: 'Bo' });
    assert.deepEqual(deleted.pullEvents(), [{ type: 'WorkItemDeleted', workItemId: 1, occurredAt: LATER }]);
    assert.deepEqual(deleted.references, { parentId: 3, iterationId: 's1', assignedTo: null, linkedItemIds: [2, 4] });
    const snapshot = deleted.toSnapshot();
    assert.equal(snapshot.deletedBy, 'Bo');
    assert.equal(snapshot.links.length, 2);

    const back = DeletedWorkItem.reconstitute(snapshot).restore({
      parent: false,
      sprint: true,
      member: true,
      existingItemIds: new Set([1, 2]),
      context: ctx('e5'),
    });
    assert.equal(back.item.parentId, null);
    assert.equal(back.item.iterationId, 's1');
    assert.deepEqual(back.links.map((l) => l.id), ['l1']);
  });
});
