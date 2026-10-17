// Composition root: the only code that knows the concrete classes and wires them together.
// main.ts starts the server with it; tests build apps with it.

import type { AppDeps } from '#application/deps.ts';
import { UpdateSettings } from '#application/settings/update-settings.ts';
import { CopyCapacity } from '#application/sprints/copy-capacity.ts';
import { CreateSprint } from '#application/sprints/create-sprint.ts';
import { DeleteSprint } from '#application/sprints/delete-sprint.ts';
import { SetCapacity } from '#application/sprints/set-capacity.ts';
import { UpdateSprint } from '#application/sprints/update-sprint.ts';
import { CreateMember } from '#application/team/create-member.ts';
import { DeleteMember } from '#application/team/delete-member.ts';
import { UpdateMember } from '#application/team/update-member.ts';
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
import { JsonMemberRepository } from '#infrastructure/json-store/member-repository.ts';
import { JsonSettingsRepository } from '#infrastructure/json-store/settings-repository.ts';
import { JsonCapacityRepository, JsonSprintRepository } from '#infrastructure/json-store/sprint-repository.ts';
import { JsonRecycleBinRepository } from '#infrastructure/json-store/recycle-bin-repository.ts';
import type { Store } from '#infrastructure/json-store/store.ts';
import { StoreUnitOfWork } from '#infrastructure/json-store/unit-of-work.ts';
import { JsonWorkItemRepository } from '#infrastructure/json-store/work-item-repository.ts';
import { LocalEventBus } from '#infrastructure/local-event-bus.ts';
import { RandomIds } from '#infrastructure/random-ids.ts';
import { SystemClock } from '#infrastructure/system-clock.ts';
import type { CallerResolver } from '#presentation/http/caller.ts';
import { combineRoutes, type Router } from '#presentation/http/router.ts';
import { teamRoutes } from '#presentation/team/routes.ts';
import { workItemRoutes } from '#presentation/work-items/routes.ts';
import { createExpressApp, type AppOptions } from '../server/app.ts';
import { AuthManager } from '../server/auth.ts';

export interface CreateAppOptions extends Omit<AppOptions, 'layeredRoutes'> {
  /** Where published domain events go; a private bus if omitted. */
  readonly events?: LocalEventBus;
}

/** Repositories over the JSON store, plus the services every use case shares. */
export function composeDeps(store: Store, auth: AuthManager, events: LocalEventBus): AppDeps {
  const unitOfWork = new StoreUnitOfWork(store);
  return {
    items: new JsonWorkItemRepository(unitOfWork),
    links: new JsonLinkRepository(unitOfWork),
    recycleBin: new JsonRecycleBinRepository(unitOfWork),
    sprints: new JsonSprintRepository(unitOfWork),
    capacities: new JsonCapacityRepository(unitOfWork),
    members: new JsonMemberRepository(unitOfWork),
    settings: new JsonSettingsRepository(unitOfWork),
    // Administrators are part of sign-in, which still lives in server/auth.ts.
    safeguard: { keepsUsableAdmin: async (members) => auth.keepsUsableAdmin(members) },
    clock: new SystemClock(),
    ids: new RandomIds(),
    events,
    unitOfWork,
  };
}

/** Every slice that has moved into the layers, as HTTP routes relative to /api. */
export function composeRoutes(deps: AppDeps, identify: CallerResolver): Pick<Router, 'handle' | 'owns'> {
  const workItems = workItemRoutes({
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
  const team = teamRoutes({
    identify,
    createSprint: new CreateSprint(deps),
    updateSprint: new UpdateSprint(deps),
    deleteSprint: new DeleteSprint(deps),
    setCapacity: new SetCapacity(deps),
    copyCapacity: new CopyCapacity(deps),
    createMember: new CreateMember(deps),
    updateMember: new UpdateMember(deps),
    deleteMember: new DeleteMember(deps),
    updateSettings: new UpdateSettings(deps),
  });
  return combineRoutes(workItems, team);
}

/** The whole app: the layered slices plugged into the Express server that still hosts the rest. */
export function createApp(options: CreateAppOptions) {
  const { events = new LocalEventBus(), auth = new AuthManager(options.store), ...rest } = options;
  const deps = composeDeps(options.store, auth, events);
  return createExpressApp({ ...rest, auth, layeredRoutes: (identify) => composeRoutes(deps, identify) });
}
