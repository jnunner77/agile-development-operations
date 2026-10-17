// Composition root: the only code that knows the concrete classes and wires them together.
// main.ts starts the server with it; tests build apps with it.

import type { WorkItemDeps } from '#application/work-items/deps.ts';
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
import { JsonLinkRepository } from '#infrastructure/json-store/link-repository.ts';
import { JsonProjectDirectory } from '#infrastructure/json-store/project-directory.ts';
import { JsonRecycleBinRepository } from '#infrastructure/json-store/recycle-bin-repository.ts';
import type { Store } from '#infrastructure/json-store/store.ts';
import { StoreUnitOfWork } from '#infrastructure/json-store/unit-of-work.ts';
import { JsonWorkItemRepository } from '#infrastructure/json-store/work-item-repository.ts';
import { LocalEventBus } from '#infrastructure/local-event-bus.ts';
import { RandomIds } from '#infrastructure/random-ids.ts';
import { SystemClock } from '#infrastructure/system-clock.ts';
import type { CallerResolver } from '#presentation/http/caller.ts';
import type { Router } from '#presentation/http/router.ts';
import { workItemRoutes } from '#presentation/work-items/routes.ts';
import { createExpressApp, type AppOptions } from '../server/app.ts';

export interface CreateAppOptions extends Omit<AppOptions, 'layeredRoutes'> {
  /** Where published domain events go; a private bus if omitted. */
  readonly events?: LocalEventBus;
}

/** The work item slice over the JSON store, as HTTP routes relative to /api. */
export function composeWorkItemRoutes(store: Store, identify: CallerResolver, events: LocalEventBus): Router {
  const unitOfWork = new StoreUnitOfWork(store);
  const deps: WorkItemDeps = {
    items: new JsonWorkItemRepository(unitOfWork),
    links: new JsonLinkRepository(unitOfWork),
    recycleBin: new JsonRecycleBinRepository(unitOfWork),
    project: new JsonProjectDirectory(unitOfWork),
    clock: new SystemClock(),
    ids: new RandomIds(),
    events,
    unitOfWork,
  };
  return workItemRoutes({
    identify,
    createWorkItem: new CreateWorkItem(deps),
    updateWorkItem: new UpdateWorkItem(deps),
    moveWorkItem: new MoveWorkItem(deps),
    bulkUpdateWorkItems: new BulkUpdateWorkItems(deps),
    deleteWorkItem: new DeleteWorkItem(deps),
    deleteWorkItems: new DeleteWorkItems(deps),
    copyWorkItem: new CopyWorkItem(deps),
    restoreWorkItem: new RestoreWorkItem(deps),
    purgeWorkItem: new PurgeWorkItem(deps),
    addLink: new AddLink(deps),
    removeLink: new RemoveLink(deps),
    addComment: new AddComment(deps),
    editComment: new EditComment(deps),
    deleteComment: new DeleteComment(deps),
    addHyperlink: new AddHyperlink(deps),
    removeHyperlink: new RemoveHyperlink(deps),
  });
}

/** The whole app: the layered slices plugged into the Express server that still hosts the rest. */
export function createApp(options: CreateAppOptions) {
  const { events = new LocalEventBus(), ...rest } = options;
  return createExpressApp({ ...rest, layeredRoutes: (identify) => composeWorkItemRoutes(options.store, identify, events) });
}
