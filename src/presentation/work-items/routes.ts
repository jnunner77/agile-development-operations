import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Committed } from '#application/ports.ts';
import type { AddComment } from '#application/work-items/add-comment.ts';
import type { AddHyperlink } from '#application/work-items/add-hyperlink.ts';
import type { AddLink } from '#application/work-items/add-link.ts';
import type { BulkUpdateWorkItems } from '#application/work-items/bulk-update-work-items.ts';
import type { CopyWorkItem } from '#application/work-items/copy-work-item.ts';
import type { CreateWorkItem } from '#application/work-items/create-work-item.ts';
import type { DeleteComment } from '#application/work-items/delete-comment.ts';
import type { DeleteWorkItem } from '#application/work-items/delete-work-item.ts';
import type { DeleteWorkItems } from '#application/work-items/delete-work-items.ts';
import type { WorkItemsError } from '#application/work-items/deps.ts';
import type { EditComment } from '#application/work-items/edit-comment.ts';
import type { MoveWorkItem } from '#application/work-items/move-work-item.ts';
import type { PurgeWorkItem } from '#application/work-items/purge-work-item.ts';
import type { RemoveHyperlink } from '#application/work-items/remove-hyperlink.ts';
import type { RemoveLink } from '#application/work-items/remove-link.ts';
import type { RestoreWorkItem } from '#application/work-items/restore-work-item.ts';
import type { UpdateWorkItem } from '#application/work-items/update-work-item.ts';
import { assertNever, err, ok, type Result } from '#shared/result.ts';
import { readJsonBody, type BodyError } from '../http/body.ts';
import type { CallerResolver } from '../http/caller.ts';
import type { Parsed } from '../http/parse.ts';
import { sendError, sendJson } from '../http/respond.ts';
import { Router } from '../http/router.ts';
import { httpFailure } from './errors.ts';
import {
  parseBulk,
  parseCommentText,
  parseCopy,
  parseCreate,
  parseFields,
  parseHyperlink,
  parseId,
  parseIds,
  parseLink,
  parseMove,
} from './parsers.ts';

export interface WorkItemRouteDeps {
  readonly identify: CallerResolver;
  readonly createWorkItem: Pick<CreateWorkItem, 'execute'>;
  readonly updateWorkItem: Pick<UpdateWorkItem, 'execute'>;
  readonly moveWorkItem: Pick<MoveWorkItem, 'execute'>;
  readonly bulkUpdateWorkItems: Pick<BulkUpdateWorkItems, 'execute'>;
  readonly deleteWorkItem: Pick<DeleteWorkItem, 'execute'>;
  readonly deleteWorkItems: Pick<DeleteWorkItems, 'execute'>;
  readonly copyWorkItem: Pick<CopyWorkItem, 'execute'>;
  readonly restoreWorkItem: Pick<RestoreWorkItem, 'execute'>;
  readonly purgeWorkItem: Pick<PurgeWorkItem, 'execute'>;
  readonly addLink: Pick<AddLink, 'execute'>;
  readonly removeLink: Pick<RemoveLink, 'execute'>;
  readonly addComment: Pick<AddComment, 'execute'>;
  readonly editComment: Pick<EditComment, 'execute'>;
  readonly deleteComment: Pick<DeleteComment, 'execute'>;
  readonly addHyperlink: Pick<AddHyperlink, 'execute'>;
  readonly removeHyperlink: Pick<RemoveHyperlink, 'execute'>;
}

/** Answer with `{ delta, result }`, or with the error's status and message. */
async function reply<T, E extends WorkItemsError>(res: ServerResponse, pending: Promise<Result<Committed<T>, E>>, status: number): Promise<void> {
  const result = await pending;
  if (result.ok) {
    sendJson(res, status, { delta: result.value.delta, result: result.value.result });
    return;
  }
  const failure = httpFailure(result.error);
  sendError(res, failure.status, failure.message);
}

function bodyFailure(res: ServerResponse, error: BodyError): void {
  switch (error.code) {
    case 'MALFORMED_JSON':
      return sendError(res, 400, 'Malformed JSON');
    case 'BODY_TOO_LARGE':
      return sendError(res, 413, 'Request is too large');
    default:
      return assertNever(error);
  }
}

/** Read and parse the body; on failure the error response has already been sent. */
async function input<T>(req: IncomingMessage, res: ServerResponse, parse: (body: unknown) => Parsed<T>): Promise<Result<T, null>> {
  const body = await readJsonBody(req);
  if (!body.ok) {
    bodyFailure(res, body.error);
    return err(null);
  }
  const parsed = parse(body.value);
  if (!parsed.ok) {
    sendError(res, 400, parsed.error.message);
    return err(null);
  }
  return ok(parsed.value);
}

/** A numeric path id; on failure the error response has already been sent. */
function pathId(res: ServerResponse, raw: string | undefined): Result<number, null> {
  const id = parseId(raw);
  if (id.ok) return id;
  sendError(res, 400, id.error.message);
  return err(null);
}

/** Work item, link and recycle bin routes, relative to /api. */
export function workItemRoutes(deps: WorkItemRouteDeps): Router {
  const { identify } = deps;
  return new Router()
    .add('POST', '/workitems', async (req, res) => {
      const body = await input(req, res, parseCreate);
      if (body.ok) await reply(res, deps.createWorkItem.execute({ caller: identify(req, res), ...body.value }), 201);
    })
    .add('POST', '/workitems/bulk', async (req, res) => {
      const body = await input(req, res, parseBulk);
      if (body.ok) await reply(res, deps.bulkUpdateWorkItems.execute({ caller: identify(req, res), ...body.value }), 200);
    })
    .add('POST', '/workitems/bulk-delete', async (req, res) => {
      const body = await input(req, res, parseIds);
      if (body.ok) await reply(res, deps.deleteWorkItems.execute({ caller: identify(req, res), ids: body.value.ids }), 200);
    })
    .add('PATCH', '/workitems/:id', async (req, res, params) => {
      const id = pathId(res, params['id']);
      if (!id.ok) return;
      const body = await input(req, res, (b) => parseFields(b));
      if (body.ok) await reply(res, deps.updateWorkItem.execute({ caller: identify(req, res), id: id.value, changes: body.value }), 200);
    })
    .add('DELETE', '/workitems/:id', async (req, res, params) => {
      const id = pathId(res, params['id']);
      if (id.ok) await reply(res, deps.deleteWorkItem.execute({ caller: identify(req, res), id: id.value }), 200);
    })
    .add('POST', '/workitems/:id/move', async (req, res, params) => {
      const id = pathId(res, params['id']);
      if (!id.ok) return;
      const body = await input(req, res, parseMove);
      if (body.ok) await reply(res, deps.moveWorkItem.execute({ caller: identify(req, res), id: id.value, ...body.value }), 200);
    })
    .add('POST', '/workitems/:id/copy', async (req, res, params) => {
      const id = pathId(res, params['id']);
      if (!id.ok) return;
      const body = await input(req, res, parseCopy);
      if (body.ok) await reply(res, deps.copyWorkItem.execute({ caller: identify(req, res), id: id.value, ...body.value }), 201);
    })
    .add('POST', '/workitems/:id/comments', async (req, res, params) => {
      const id = pathId(res, params['id']);
      if (!id.ok) return;
      const body = await input(req, res, parseCommentText);
      if (body.ok) await reply(res, deps.addComment.execute({ caller: identify(req, res), workItemId: id.value, ...body.value }), 201);
    })
    .add('PATCH', '/workitems/:id/comments/:commentId', async (req, res, params) => {
      const id = pathId(res, params['id']);
      if (!id.ok) return;
      const body = await input(req, res, parseCommentText);
      if (!body.ok) return;
      const commentId = params['commentId'] ?? '';
      await reply(res, deps.editComment.execute({ caller: identify(req, res), workItemId: id.value, commentId, ...body.value }), 200);
    })
    .add('DELETE', '/workitems/:id/comments/:commentId', async (req, res, params) => {
      const id = pathId(res, params['id']);
      if (!id.ok) return;
      const commentId = params['commentId'] ?? '';
      await reply(res, deps.deleteComment.execute({ caller: identify(req, res), workItemId: id.value, commentId }), 200);
    })
    .add('POST', '/workitems/:id/hyperlinks', async (req, res, params) => {
      const id = pathId(res, params['id']);
      if (!id.ok) return;
      const body = await input(req, res, parseHyperlink);
      if (body.ok) await reply(res, deps.addHyperlink.execute({ caller: identify(req, res), workItemId: id.value, ...body.value }), 201);
    })
    .add('DELETE', '/workitems/:id/hyperlinks/:linkId', async (req, res, params) => {
      const id = pathId(res, params['id']);
      if (!id.ok) return;
      const hyperlinkId = params['linkId'] ?? '';
      await reply(res, deps.removeHyperlink.execute({ caller: identify(req, res), workItemId: id.value, hyperlinkId }), 200);
    })
    .add('POST', '/links', async (req, res) => {
      const body = await input(req, res, parseLink);
      if (body.ok) await reply(res, deps.addLink.execute({ caller: identify(req, res), ...body.value }), 201);
    })
    .add('DELETE', '/links/:id', async (req, res, params) => {
      await reply(res, deps.removeLink.execute({ caller: identify(req, res), linkId: params['id'] ?? '' }), 200);
    })
    .add('POST', '/recycle-bin/:id/restore', async (req, res, params) => {
      const id = pathId(res, params['id']);
      if (id.ok) await reply(res, deps.restoreWorkItem.execute({ caller: identify(req, res), id: id.value }), 200);
    })
    .add('DELETE', '/recycle-bin/:id', async (req, res, params) => {
      const id = pathId(res, params['id']);
      if (id.ok) await reply(res, deps.purgeWorkItem.execute({ caller: identify(req, res), id: id.value }), 200);
    });
}
