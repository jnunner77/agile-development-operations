// Composition root: the only code that knows the concrete classes and wires them together.
// main.ts starts the server with it; tests build apps with it.

import { CreateApiToken } from '#application/api-tokens/create-api-token.ts';
import { ListApiTokens } from '#application/api-tokens/list-api-tokens.ts';
import { RevokeApiToken } from '#application/api-tokens/revoke-api-token.ts';
import type { AppDeps } from '#application/deps.ts';
import type { Clock } from '#application/ports.ts';
import { ChangePassword } from '#application/sign-in/change-password.ts';
import type { SignInDeps } from '#application/sign-in/deps.ts';
import { GetSignInAdminView } from '#application/sign-in/get-sign-in-admin-view.ts';
import { GetSignInStatus } from '#application/sign-in/get-sign-in-status.ts';
import { IdentifyCaller } from '#application/sign-in/identify-caller.ts';
import { ResetPassword } from '#application/sign-in/reset-password.ts';
import { SetAdministrator } from '#application/sign-in/set-administrator.ts';
import { SetPassword } from '#application/sign-in/set-password.ts';
import { SignIn } from '#application/sign-in/sign-in.ts';
import { SignOut } from '#application/sign-in/sign-out.ts';
import { UpdateSignInSettings } from '#application/sign-in/update-sign-in-settings.ts';
import type { SignInSettingsData } from '#domain/sign-in/settings.ts';
import { FileApiTokenRepository } from '#infrastructure/api-tokens/token-file.ts';
import { StoreTeamDirectory } from '#infrastructure/json-store/team-directory.ts';
import { guardUsableAdmin } from '#infrastructure/sign-in/admin-guard.ts';
import { AuthFile, FileAccountRepository, FileSignInSettingsRepository } from '#infrastructure/sign-in/auth-file.ts';
import { MemoryFailedAttemptsRepository, MemorySessionRepository } from '#infrastructure/sign-in/memory-sessions.ts';
import { RandomSecrets } from '#infrastructure/sign-in/random-secrets.ts';
import { ScryptHasher } from '#infrastructure/sign-in/scrypt-hasher.ts';
import { Authenticator } from '#presentation/sign-in/authenticator.ts';
import { signInRoutes } from '#presentation/sign-in/routes.ts';
import type { RequestContext } from '#presentation/http/context.ts';
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
import { FunctionClock, SystemClock } from '#infrastructure/system-clock.ts';
import { combineRoutes, type Router } from '#presentation/http/router.ts';
import { teamRoutes } from '#presentation/team/routes.ts';
import { workItemRoutes } from '#presentation/work-items/routes.ts';
import { createExpressApp, type AppOptions } from '../server/app.ts';

export interface AuthOptions {
  /** The time, in milliseconds since the epoch; tests pass their own clock. */
  readonly now?: () => number;
  /** Force sign-in off whatever its settings say (AUTH_DISABLED): recovery if every admin is locked out. */
  readonly disabled?: boolean;
}

/** Sign-in for one data directory: its adapters, and what the rest of the app reads from it. */
export interface Auth {
  readonly deps: Pick<SignInDeps, 'accounts' | 'signInSettings' | 'sessions' | 'failedAttempts' | 'apiTokens' | 'hasher' | 'secrets' | 'signInForcedOff'> & {
    readonly clock: Clock;
  };
  /** Sign-in is on and not forced off. */
  readonly enabled: boolean;
  readonly settings: SignInSettingsData;
  /** How many usernames have failed sign-in records (for tests and diagnostics). */
  readonly trackedFailures: number;
}

export function createAuth(store: Store, options: AuthOptions = {}): Auth {
  const file = new AuthFile(store.dataDir);
  const forcedOff = !!options.disabled;
  const now = options.now ?? Date.now;
  guardUsableAdmin(store, file, forcedOff);
  const failedAttempts = new MemoryFailedAttemptsRepository();
  return {
    deps: {
      accounts: new FileAccountRepository(file),
      signInSettings: new FileSignInSettingsRepository(file),
      sessions: new MemorySessionRepository(),
      failedAttempts,
      apiTokens: new FileApiTokenRepository(store.dataDir, now),
      hasher: new ScryptHasher(),
      secrets: new RandomSecrets(),
      signInForcedOff: forcedOff,
      clock: new FunctionClock(now),
    },
    get enabled() {
      return file.settings.enabled && !forcedOff;
    },
    get settings() {
      return file.settings;
    },
    get trackedFailures() {
      return failedAttempts.size;
    },
  };
}

export interface CreateAppOptions extends Omit<AppOptions, 'layeredRoutes' | 'signIn'> {
  /** Sign-in; one is created for the store's data directory if omitted. */
  readonly auth?: Auth;
  /** Where published domain events go; a private bus if omitted. */
  readonly events?: LocalEventBus;
}

/** Repositories over the JSON store and sign-in files, plus the services every use case shares. */
export function composeDeps(store: Store, auth: Auth, events: LocalEventBus): AppDeps {
  const unitOfWork = new StoreUnitOfWork(store);
  const { clock: _signInClock, ...signIn } = auth.deps;
  return {
    items: new JsonWorkItemRepository(unitOfWork),
    links: new JsonLinkRepository(unitOfWork),
    recycleBin: new JsonRecycleBinRepository(unitOfWork),
    sprints: new JsonSprintRepository(unitOfWork),
    capacities: new JsonCapacityRepository(unitOfWork),
    members: new JsonMemberRepository(unitOfWork),
    settings: new JsonSettingsRepository(unitOfWork),
    team: new StoreTeamDirectory(store),
    ...signIn,
    clock: new SystemClock(),
    ids: new RandomIds(),
    events,
    unitOfWork,
  };
}

/** Every slice that has moved into the layers, as HTTP routes relative to /api. */
export function composeRoutes(deps: AppDeps, signInDeps: SignInDeps, context: RequestContext): Pick<Router, 'handle' | 'owns'> {
  const identify = context.caller;
  const signIn = signInRoutes({
    context,
    getSignInStatus: new GetSignInStatus(signInDeps),
    signIn: new SignIn(signInDeps),
    changePassword: new ChangePassword(signInDeps),
    signOut: new SignOut(signInDeps),
    getSignInAdminView: new GetSignInAdminView(signInDeps),
    updateSignInSettings: new UpdateSignInSettings(signInDeps),
    setAdministrator: new SetAdministrator(signInDeps),
    setPassword: new SetPassword(signInDeps),
    resetPassword: new ResetPassword(signInDeps),
    listApiTokens: new ListApiTokens(signInDeps),
    createApiToken: new CreateApiToken(signInDeps),
    revokeApiToken: new RevokeApiToken(signInDeps),
  });
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
  return combineRoutes(signIn, workItems, team);
}

/** The whole app: the layered slices plugged into the Express server that still hosts the rest. */
export function createApp(options: CreateAppOptions) {
  const { events = new LocalEventBus(), auth = createAuth(options.store), ...rest } = options;
  const deps = composeDeps(options.store, auth, events);
  // Sign-in keeps its own clock, so tests can move time for sessions, lockouts and expiry alone.
  const signInDeps: SignInDeps = { ...deps, clock: auth.deps.clock };
  const authenticator = new Authenticator(new IdentifyCaller(signInDeps));
  return createExpressApp({
    ...rest,
    signIn: {
      authenticator,
      get enabled() {
        return auth.enabled;
      },
    },
    layeredRoutes: (context) => composeRoutes(deps, signInDeps, context),
  });
}
