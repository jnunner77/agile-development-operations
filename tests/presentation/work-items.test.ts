import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { Caller } from '#application/caller.ts';
import type { Committed } from '#application/ports.ts';
import type { AddCommentInput } from '#application/work-items/add-comment.ts';
import type { AddHyperlinkInput } from '#application/work-items/add-hyperlink.ts';
import type { AddLinkInput } from '#application/work-items/add-link.ts';
import type { BulkUpdateWorkItemsInput } from '#application/work-items/bulk-update-work-items.ts';
import type { CopyWorkItemInput } from '#application/work-items/copy-work-item.ts';
import type { CreateWorkItemInput } from '#application/work-items/create-work-item.ts';
import type { DeleteCommentInput } from '#application/work-items/delete-comment.ts';
import type { DeleteWorkItemInput } from '#application/work-items/delete-work-item.ts';
import type { DeleteWorkItemsInput } from '#application/work-items/delete-work-items.ts';
import type { EditCommentInput } from '#application/work-items/edit-comment.ts';
import type { MoveWorkItemInput } from '#application/work-items/move-work-item.ts';
import type { PurgeWorkItemInput } from '#application/work-items/purge-work-item.ts';
import type { RemoveHyperlinkInput } from '#application/work-items/remove-hyperlink.ts';
import type { RemoveLinkInput } from '#application/work-items/remove-link.ts';
import type { RestoreWorkItemInput } from '#application/work-items/restore-work-item.ts';
import type { UpdateWorkItemInput } from '#application/work-items/update-work-item.ts';
import type { LinkError } from '#domain/links/link.ts';
import type { Comment, Hyperlink, WorkItem, WorkItemLink } from '#domain/types.ts';
import type { WorkItemError } from '#domain/work-items/errors.ts';
import { blankWorkItem } from '#infrastructure/json-store/schema.ts';
import { httpFailure } from '#presentation/work-items/errors.ts';
import { parseBulk, parseCreate, parseFields, parseHyperlink, parseMove } from '#presentation/work-items/parsers.ts';
import { workItemRoutes, type WorkItemRouteDeps } from '#presentation/work-items/routes.ts';
import { err, ok, type Result } from '#shared/result.ts';

const caller: Caller = { name: 'Ann', memberId: 'm1', mayModerateComments: false, origin: 'tab' };
const delta = { version: 7 };
const item: WorkItem = blankWorkItem({ id: 1, type: 'Bug', title: 'Crash' });
const comment: Comment = { id: 'c1', author: 'Ann', authorId: 'm1', text: 'Hi', createdAt: '', editedAt: null };
const hyperlink: Hyperlink = { id: 'h1', url: 'https://x.dev', comment: '', addedBy: 'Ann', addedAt: '' };
const link: WorkItemLink = { id: 'l1', sourceId: 1, targetId: 2, type: 'Related', comment: '', createdBy: 'Ann', createdAt: '' };

/** Use case inputs each fake received, by use case. */
let calls: { name: string; input: unknown }[] = [];

/** A use case that records its input and succeeds with `result`. */
function succeeds<I, O>(name: string, result: O) {
  return {
    execute: async (input: I): Promise<Result<Committed<O>, never>> => {
      calls.push({ name, input });
      return ok({ result, delta });
    },
  };
}

/** A use case that records its input and fails with `error`. */
function fails<I, E>(name: string, error: E) {
  return {
    execute: async (input: I): Promise<Result<never, E>> => {
      calls.push({ name, input });
      return err(error);
    },
  };
}

const fakes: WorkItemRouteDeps = {
  identify: () => caller,
  createWorkItem: succeeds<CreateWorkItemInput, WorkItem>('createWorkItem', item),
  updateWorkItem: succeeds<UpdateWorkItemInput, WorkItem>('updateWorkItem', item),
  moveWorkItem: succeeds<MoveWorkItemInput, WorkItem>('moveWorkItem', item),
  bulkUpdateWorkItems: succeeds<BulkUpdateWorkItemsInput, void>('bulkUpdateWorkItems', undefined),
  deleteWorkItem: succeeds<DeleteWorkItemInput, void>('deleteWorkItem', undefined),
  deleteWorkItems: succeeds<DeleteWorkItemsInput, void>('deleteWorkItems', undefined),
  copyWorkItem: succeeds<CopyWorkItemInput, WorkItem>('copyWorkItem', item),
  restoreWorkItem: succeeds<RestoreWorkItemInput, WorkItem>('restoreWorkItem', item),
  purgeWorkItem: succeeds<PurgeWorkItemInput, void>('purgeWorkItem', undefined),
  addLink: succeeds<AddLinkInput, WorkItemLink>('addLink', link),
  removeLink: succeeds<RemoveLinkInput, void>('removeLink', undefined),
  addComment: succeeds<AddCommentInput, Comment>('addComment', comment),
  editComment: succeeds<EditCommentInput, Comment>('editComment', comment),
  deleteComment: succeeds<DeleteCommentInput, void>('deleteComment', undefined),
  addHyperlink: succeeds<AddHyperlinkInput, Hyperlink>('addHyperlink', hyperlink),
  removeHyperlink: succeeds<RemoveHyperlinkInput, void>('removeHyperlink', undefined),
};

let routes = workItemRoutes(fakes);
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
  routes = workItemRoutes(fakes);
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

describe('work item routes', () => {
  it('creates with 201 and replies with the delta and result', async () => {
    const res = await call('POST', '/workitems', { type: 'Bug', title: 'Crash', effort: 3, position: 'top' });
    assert.deepEqual(res, { status: 201, body: { delta, result: item } });
    assert.deepEqual(calls, [{ name: 'createWorkItem', input: { caller, type: 'Bug', fields: { title: 'Crash', effort: 3 }, position: 'top' } }]);
  });

  it('routes every endpoint to its use case with the parsed input', async () => {
    const cases: [string, string, unknown, string, number][] = [
      ['PATCH', '/workitems/4', { state: 'Done' }, 'updateWorkItem', 200],
      ['DELETE', '/workitems/4', undefined, 'deleteWorkItem', 200],
      ['POST', '/workitems/4/move', { afterId: 2 }, 'moveWorkItem', 200],
      ['POST', '/workitems/4/copy', undefined, 'copyWorkItem', 201],
      ['POST', '/workitems/bulk', { ids: [4], changes: {} }, 'bulkUpdateWorkItems', 200],
      ['POST', '/workitems/bulk-delete', { ids: [4] }, 'deleteWorkItems', 200],
      ['POST', '/workitems/4/comments', { text: 'Hi' }, 'addComment', 201],
      ['PATCH', '/workitems/4/comments/c1', { text: 'Hi' }, 'editComment', 200],
      ['DELETE', '/workitems/4/comments/c1', undefined, 'deleteComment', 200],
      ['POST', '/workitems/4/hyperlinks', { url: 'https://x.dev' }, 'addHyperlink', 201],
      ['DELETE', '/workitems/4/hyperlinks/h1', undefined, 'removeHyperlink', 200],
      ['POST', '/links', { sourceId: 1, targetId: 2, type: 'Related' }, 'addLink', 201],
      ['DELETE', '/links/l1', undefined, 'removeLink', 200],
      ['POST', '/recycle-bin/4/restore', undefined, 'restoreWorkItem', 200],
      ['DELETE', '/recycle-bin/4', undefined, 'purgeWorkItem', 200],
    ];
    for (const [method, path, body, name, status] of cases) {
      calls = [];
      const res = await call(method, path, body);
      assert.equal(res.status, status, `${method} ${path}`);
      assert.equal(calls[0]?.name, name, `${method} ${path}`);
    }
    calls = [];
    await call('PATCH', '/workitems/4/comments/c1', { text: 'Hi' });
    assert.deepEqual(calls[0]?.input, { caller, workItemId: 4, commentId: 'c1', text: 'Hi' });
  });

  it('leaves requests it does not own to the next handler', async () => {
    assert.deepEqual(await call('DELETE', '/workitems/4/devlinks/x'), { status: 404, body: 'not mine' });
    assert.deepEqual(await call('GET', '/workitems'), { status: 404, body: 'not mine' });
  });

  it('turns use case errors into statuses and messages', async () => {
    routes = workItemRoutes({
      ...fakes,
      updateWorkItem: fails<UpdateWorkItemInput, WorkItemError>('updateWorkItem', { code: 'WORK_ITEM_NOT_FOUND', id: 9 }),
      deleteComment: fails<DeleteCommentInput, WorkItemError>('deleteComment', { code: 'COMMENT_FORBIDDEN' }),
      removeLink: fails<RemoveLinkInput, LinkError>('removeLink', { code: 'LINK_NOT_FOUND', id: 'l9' }),
    });
    assert.deepEqual(await call('PATCH', '/workitems/9', { title: 'x' }), { status: 404, body: { error: 'Work item 9 not found' } });
    assert.equal((await call('DELETE', '/workitems/9/comments/c')).status, 403);
    assert.deepEqual(await call('DELETE', '/links/l9'), { status: 404, body: { error: 'Link not found' } });
  });

  it('refuses malformed requests before calling a use case', async () => {
    assert.deepEqual(await call('PATCH', '/workitems/abc', { title: 'x' }), { status: 400, body: { error: 'Invalid id' } });
    assert.deepEqual(await call('PATCH', '/workitems/1', { bogus: 1 }), { status: 400, body: { error: 'Unrecognized field "bogus"' } });
    const malformed = await fetch(`${base}/workitems`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
    assert.deepEqual([malformed.status, await malformed.json()], [400, { error: 'Malformed JSON' }]);
    assert.equal((await call('POST', '/workitems', { title: 'x' })).status, 400);
    assert.deepEqual(calls, []);
  });
});

describe('request parsing', () => {
  it('reads fields in order, with their JSON types', () => {
    assert.deepEqual(parseFields({ effort: 3, title: 'x', iterationId: null, tags: ['a'] }), {
      ok: true,
      value: { effort: 3, title: 'x', iterationId: null, tags: ['a'] },
    });
    assert.deepEqual(parseFields({ effort: '3' }), { ok: false, error: { code: 'INVALID_REQUEST', message: 'effort: Expected a number' } });
    assert.deepEqual(parseFields({ tags: ['a', 1] }), { ok: false, error: { code: 'INVALID_REQUEST', message: 'tags.1: Expected text' } });
    assert.deepEqual(parseFields('x'), { ok: false, error: { code: 'INVALID_REQUEST', message: 'Expected a JSON object' } });
  });

  it('requires a type and title to create', () => {
    assert.deepEqual(parseCreate({ type: 'Bug' }), { ok: false, error: { code: 'INVALID_REQUEST', message: 'title: Required' } });
    assert.deepEqual(parseCreate({ type: 'Bug', title: 'x', position: 'middle' }), {
      ok: false,
      error: { code: 'INVALID_REQUEST', message: 'position: Expected one of top, bottom' },
    });
  });

  it('keeps titles out of bulk edits and bounds the id list', () => {
    assert.deepEqual(parseBulk({ ids: [1], changes: { title: 'x' } }), { ok: false, error: { code: 'INVALID_REQUEST', message: 'Unrecognized field "changes.title"' } });
    assert.equal(parseBulk({ ids: [], changes: {} }).ok, false);
    assert.equal(parseBulk({ ids: Array.from({ length: 1001 }, (_, i) => i), changes: {} }).ok, false);
    assert.equal(parseBulk({ ids: [1] }).ok, false);
  });

  it('checks move ids are whole numbers and hyperlinks are URLs', () => {
    assert.equal(parseMove({ afterId: 1.5 }).ok, false);
    assert.equal(parseMove({ title: 'x' }).ok, false);
    assert.deepEqual(parseHyperlink({ url: 'not a url' }), { ok: false, error: { code: 'INVALID_REQUEST', message: 'url: Invalid URL' } });
  });
});

describe('error mapping', () => {
  it('gives each error a status and a readable message', () => {
    assert.deepEqual(httpFailure({ code: 'INVALID_STATE', state: 'Committed', type: 'Task' }), {
      status: 400,
      message: '"Committed" is not a valid state for a Task',
    });
    assert.deepEqual(httpFailure({ code: 'INVALID_DATE', field: 'dueDate' }), { status: 400, message: 'Due date: Expected a date in YYYY-MM-DD format' });
    assert.deepEqual(httpFailure({ code: 'ITEM_TAG_LIMIT', id: 3, max: 100 }), { status: 400, message: 'Work item 3 would have more than 100 tags' });
    assert.deepEqual(httpFailure({ code: 'DELETED_WORK_ITEM_NOT_FOUND', id: 3 }), { status: 404, message: 'Deleted work item 3 not found' });
  });
});
