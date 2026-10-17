import type { AddComment } from '#application/work-items/add-comment.ts';
import type { AddHyperlink } from '#application/work-items/add-hyperlink.ts';
import type { AddLink } from '#application/work-items/add-link.ts';
import type { BulkUpdateWorkItems } from '#application/work-items/bulk-update-work-items.ts';
import type { CopyWorkItem } from '#application/work-items/copy-work-item.ts';
import type { CreateWorkItem } from '#application/work-items/create-work-item.ts';
import type { DeleteComment } from '#application/work-items/delete-comment.ts';
import type { DeleteWorkItem } from '#application/work-items/delete-work-item.ts';
import type { DeleteWorkItems } from '#application/work-items/delete-work-items.ts';
import type { EditComment } from '#application/work-items/edit-comment.ts';
import type { MoveWorkItem } from '#application/work-items/move-work-item.ts';
import type { PurgeWorkItem } from '#application/work-items/purge-work-item.ts';
import type { RemoveDevLink } from '#application/work-items/remove-dev-link.ts';
import type { RemoveHyperlink } from '#application/work-items/remove-hyperlink.ts';
import type { RemoveLink } from '#application/work-items/remove-link.ts';
import type { RestoreWorkItem } from '#application/work-items/restore-work-item.ts';
import type { UpdateWorkItem } from '#application/work-items/update-work-item.ts';
import type { CallerResolver } from '../http/caller.ts';
import { input, pathId, reply } from '../http/handlers.ts';
import { Router } from '../http/router.ts';
import {
  parseBulk,
  parseCommentText,
  parseCopy,
  parseCreate,
  parseFields,
  parseHyperlink,
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
  readonly removeDevLink: Pick<RemoveDevLink, 'execute'>;
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
    .add('DELETE', '/workitems/:id/devlinks/:linkId', async (req, res, params) => {
      const id = pathId(res, params['id']);
      if (!id.ok) return;
      const linkId = params['linkId'] ?? '';
      await reply(res, deps.removeDevLink.execute({ caller: identify(req, res), workItemId: id.value, linkId }), 200);
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
