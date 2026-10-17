import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CommentText } from '#domain/work-items/comments.ts';
import { FieldChanges } from '#domain/work-items/fields.ts';
import { HyperlinkDraft } from '#domain/work-items/hyperlinks.ts';
import { WorkItemAggregate } from '#domain/work-items/work-item.ts';
import { LATER, NOW, changes, ctx, id, newItem } from './fixtures.ts';

const text = (raw: string) => {
  const r = CommentText.of(raw);
  assert.ok(r.ok);
  return r.value;
};

describe('creating a work item', () => {
  it('starts in the first state with type defaults and a Created history entry', () => {
    const result = WorkItemAggregate.create({
      id: id(5),
      type: 'Bug',
      fields: changes({ title: 'Crash', effort: 3, tags: ['a', 'A'] }),
      parent: undefined,
      defaultAreaPath: 'Fabrikam',
      stackRank: 2000,
      context: ctx('e1'),
    });
    assert.ok(result.ok);
    const w = result.value.toSnapshot();
    assert.equal(w.state, 'New');
    assert.equal(w.reason, 'New');
    assert.equal(w.severity, '3 - Medium');
    assert.equal(w.valueArea, 'Business');
    assert.equal(w.areaPath, 'Fabrikam');
    assert.equal(w.stackRank, 2000);
    assert.deepEqual(w.tags, ['a']);
    assert.equal(w.createdBy, 'Ann');
    assert.equal(w.createdAt, NOW.toISOString());
    assert.deepEqual(w.history, [
      {
        id: 'e1',
        changedBy: 'Ann',
        changedAt: NOW.toISOString(),
        note: 'Created',
        changes: [
          { field: 'title', oldValue: null, newValue: 'Crash' },
          { field: 'state', oldValue: null, newValue: 'New' },
          { field: 'iterationId', oldValue: null, newValue: null },
          { field: 'effort', oldValue: null, newValue: 3 },
        ],
      },
    ]);
    assert.deepEqual(result.value.pullEvents(), [{ type: 'WorkItemCreated', workItemId: 5, workItemType: 'Bug', occurredAt: NOW }]);
    assert.deepEqual(result.value.pullEvents(), []);
  });

  it('tasks inherit the area and sprint of their parent, and remaining work from the estimate', () => {
    const parent = newItem('Product Backlog Item', { iterationId: 's1', areaPath: 'Fabrikam\\Web' }, { id: 1 });
    const task = newItem('Task', { parentId: 1, originalEstimate: 6 }, { id: 2, parent });
    assert.equal(task.iterationId, 's1');
    assert.equal(task.areaPath, 'Fabrikam\\Web');
    assert.equal(task.toSnapshot().remainingWork, 6);
    // A sprint given explicitly wins, including none.
    assert.equal(newItem('Task', { parentId: 1, iterationId: null }, { id: 3, parent }).iterationId, null);
    // Backlog items don't inherit a sprint.
    const feature = newItem('Feature', { iterationId: 's1' }, { id: 4 });
    assert.equal(newItem('Product Backlog Item', { parentId: 4 }, { id: 5, parent: feature }).iterationId, null);
  });

  it('can be created closed', () => {
    const w = newItem('Task', { state: 'Done' }).toSnapshot();
    assert.equal(w.reason, 'Work finished');
    assert.equal(w.closedAt, NOW.toISOString());
  });

  it('refuses a state the type does not have, or a missing title', () => {
    const base = { id: id(1), parent: undefined, defaultAreaPath: 'F', stackRank: 0, context: ctx() };
    assert.deepEqual(WorkItemAggregate.create({ ...base, type: 'Task', fields: changes({ title: 'x', state: 'Committed' }) }), {
      ok: false,
      error: { code: 'INVALID_STATE', state: 'Committed', type: 'Task' },
    });
    assert.deepEqual(WorkItemAggregate.create({ ...base, type: 'Task', fields: FieldChanges.none }), { ok: false, error: { code: 'TITLE_REQUIRED' } });
  });
});

describe('changing a work item', () => {
  it('records changed fields with the state reason and closed date', () => {
    const item = newItem('Product Backlog Item');
    const result = item.update(changes({ state: 'Committed', effort: 5, title: 'Product Backlog Item item' }), ctx('e2', LATER, 'Bo'));
    assert.deepEqual(result, {
      ok: true,
      value: [
        { field: 'state', oldValue: 'New', newValue: 'Committed' },
        { field: 'effort', oldValue: null, newValue: 5 },
        { field: 'reason', oldValue: 'New', newValue: 'Commitment made by the team' },
      ],
    });
    const w = item.toSnapshot();
    assert.equal(w.changedBy, 'Bo');
    assert.equal(w.changedAt, LATER.toISOString());
    assert.equal(w.history.at(-1)?.id, 'e2');
    assert.deepEqual(item.pullEvents(), [{ type: 'WorkItemChanged', workItemId: 1, fields: ['state', 'effort', 'reason'], occurredAt: LATER }]);

    item.update(changes({ state: 'Done' }), ctx('e3', LATER));
    assert.equal(item.toSnapshot().closedAt, LATER.toISOString());
    item.update(changes({ state: 'Committed' }), ctx('e4'));
    assert.equal(item.toSnapshot().closedAt, null);
  });

  it('burns down remaining work when a task is done', () => {
    const task = newItem('Task', { originalEstimate: 6 });
    const result = task.update(changes({ state: 'Done' }), ctx());
    assert.ok(result.ok);
    assert.deepEqual(result.value.at(-1), { field: 'remainingWork', oldValue: 6, newValue: 0 });
    assert.equal(task.toSnapshot().remainingWork, 0);
  });

  it('records nothing when nothing changes', () => {
    const item = newItem('Epic', { tags: ['a'] });
    assert.deepEqual(item.update(changes({ title: 'Epic item', tags: [' a '] }), ctx('e2')), { ok: true, value: [] });
    assert.equal(item.toSnapshot().history.length, 1);
    assert.deepEqual(item.pullEvents(), []);
  });

  it('adds a note only when something changed', () => {
    const item = newItem('Task', { parentId: 9 });
    item.update(changes({ parentId: null }), ctx('e2'), 'Parent #9 was deleted');
    assert.equal(item.toSnapshot().history.at(-1)?.note, 'Parent #9 was deleted');
  });

  it('refuses a state the type does not have, changing nothing', () => {
    const task = newItem('Task');
    assert.deepEqual(task.update(changes({ title: 'New', state: 'Committed' }), ctx()), {
      ok: false,
      error: { code: 'INVALID_STATE', state: 'Committed', type: 'Task' },
    });
    assert.equal(task.title, 'Task item');
  });

  it('never shares arrays with the caller', () => {
    const item = newItem('Epic', { tags: ['a'] });
    const snapshot = item.toSnapshot();
    snapshot.tags.push('b');
    snapshot.history.length = 0;
    assert.deepEqual(item.tags, ['a']);
    assert.equal(item.toSnapshot().history.length, 1);
  });
});

describe('comments', () => {
  it('lets the author or a moderator change a comment', () => {
    const item = newItem('Bug');
    const c = item.addComment({ id: 'c1', text: text(' <p>Hi</p> '), authorId: 'm1' }, { now: LATER, actor: 'Bo' });
    assert.deepEqual(c, { id: 'c1', author: 'Bo', authorId: 'm1', text: '<p>Hi</p>', createdAt: LATER.toISOString(), editedAt: null });
    assert.equal(item.toSnapshot().changedBy, 'Bo');

    const stranger = { memberId: 'm2', mayModerate: false };
    assert.deepEqual(item.editComment('c1', text('x'), stranger, LATER), { ok: false, error: { code: 'COMMENT_FORBIDDEN' } });
    assert.deepEqual(item.deleteComment('c1', stranger, LATER), { ok: false, error: { code: 'COMMENT_FORBIDDEN' } });
    assert.deepEqual(item.editComment('nope', text('x'), stranger, LATER), { ok: false, error: { code: 'COMMENT_NOT_FOUND', id: 'nope' } });

    const edited = item.editComment('c1', text('Edited'), { memberId: 'm1', mayModerate: false }, LATER);
    assert.ok(edited.ok);
    assert.equal(edited.value.editedAt, LATER.toISOString());
    assert.deepEqual(item.deleteComment('c1', { memberId: null, mayModerate: true }, LATER), { ok: true, value: undefined });
    assert.deepEqual(item.toSnapshot().comments, []);
    assert.deepEqual(
      item.pullEvents().map((e) => e.type),
      ['CommentAdded', 'CommentEdited', 'CommentDeleted'],
    );
  });

  it('comments without an author can only be changed by a moderator', () => {
    const item = newItem('Bug');
    item.addComment({ id: 'c1', text: text('x'), authorId: null }, { now: NOW, actor: 'Anonymous' });
    assert.equal(item.deleteComment('c1', { memberId: null, mayModerate: false }, NOW).ok, false);
  });

  it('refuses empty or overlong comment text', () => {
    assert.deepEqual(CommentText.of('   '), { ok: false, error: { code: 'COMMENT_EMPTY' } });
    assert.deepEqual(CommentText.of('x'.repeat(100_001)), { ok: false, error: { code: 'TEXT_TOO_LONG', field: 'text', max: 100_000 } });
  });
});

describe('hyperlinks', () => {
  it('allows only http(s) links', () => {
    assert.deepEqual(HyperlinkDraft.of({ url: 'javascript:alert(1)' }), { ok: false, error: { code: 'HYPERLINK_NOT_HTTP' } });
    assert.deepEqual(HyperlinkDraft.of({ url: 'https://' }), { ok: false, error: { code: 'HYPERLINK_NOT_HTTP' } });
    assert.deepEqual(HyperlinkDraft.of({ url: 'https://x.dev', comment: 'x'.repeat(1001) }), {
      ok: false,
      error: { code: 'TEXT_TOO_LONG', field: 'comment', max: 1000 },
    });
  });

  it('adds and removes links with history notes', () => {
    const item = newItem('Bug');
    const draft = HyperlinkDraft.of({ url: ' https://example.com/spec ', comment: 'spec' });
    assert.ok(draft.ok);
    const link = item.addHyperlink(draft.value, 'l1', ctx('e2'));
    assert.deepEqual(link, { id: 'l1', url: 'https://example.com/spec', comment: 'spec', addedBy: 'Ann', addedAt: NOW.toISOString() });
    assert.equal(item.toSnapshot().history.at(-1)?.note, 'Added hyperlink https://example.com/spec');
    assert.deepEqual(item.removeHyperlink('nope', ctx('e3')), { ok: false, error: { code: 'HYPERLINK_NOT_FOUND', id: 'nope' } });
    assert.deepEqual(item.removeHyperlink('l1', ctx('e3')), { ok: true, value: undefined });
    assert.equal(item.toSnapshot().history.at(-1)?.note, 'Removed hyperlink https://example.com/spec');
  });
});

describe('restoring', () => {
  it('drops references to things that no longer exist', () => {
    const item = newItem('Task', { parentId: 3, iterationId: 's1', assignedTo: 'm1' });
    item.restore({ parent: false, sprint: true, member: false }, ctx('e9'));
    assert.equal(item.parentId, null);
    assert.equal(item.iterationId, 's1');
    assert.equal(item.assignedTo, null);
    assert.equal(item.toSnapshot().history.at(-1)?.note, 'Restored from recycle bin');
  });
});

describe('reconstituting', () => {
  it('throws on corrupt data', () => {
    const snapshot = newItem('Epic').toSnapshot();
    assert.throws(() => WorkItemAggregate.reconstitute({ ...snapshot, type: 'Story' as 'Epic' }), /unknown type/);
    assert.deepEqual(WorkItemAggregate.reconstitute(snapshot).toSnapshot(), snapshot);
  });
});
