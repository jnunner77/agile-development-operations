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
import { RemoveDevLink } from '#application/work-items/remove-dev-link.ts';
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
import { GetGitHubAdminView } from '#application/integrations/get-github-admin-view.ts';
import { GetWebhookStatus } from '#application/integrations/get-webhook-status.ts';
import { ReceiveGitHubDelivery } from '#application/integrations/receive-github-delivery.ts';
import { RotateWebhookSecret } from '#application/integrations/rotate-webhook-secret.ts';
import { UpdateGitHubSettings } from '#application/integrations/update-github-settings.ts';
import { MemoryDeliveryLog } from '#infrastructure/github/delivery-log.ts';
import { HmacSignatures } from '#infrastructure/github/hmac-signatures.ts';
import { GitHubPayloadReader } from '#infrastructure/github/payloads.ts';
import { FileGitHubIntegrationRepository, IntegrationsFile } from '#infrastructure/integrations/integrations-file.ts';
import { SerialQueue } from '#infrastructure/serial-writes.ts';
import { integrationRoutes } from '#presentation/integrations/routes.ts';
import { DeleteSnapshot } from '#application/backups/delete-snapshot.ts';
import { DownloadSnapshot } from '#application/backups/download-snapshot.ts';
import { ExportBackup } from '#application/backups/export-backup.ts';
import { ImportBackup } from '#application/backups/import-backup.ts';
import { ListSnapshots } from '#application/backups/list-snapshots.ts';
import { ResetProject } from '#application/backups/reset-project.ts';
import { RestoreSnapshot } from '#application/backups/restore-snapshot.ts';
import { TakeScheduledSnapshot } from '#application/backups/take-scheduled-snapshot.ts';
import { TakeSnapshot } from '#application/backups/take-snapshot.ts';
import { UpdateSnapshot } from '#application/backups/update-snapshot.ts';
import { StoreProject } from '#infrastructure/json-store/store-project.ts';
import { runEvery } from '#infrastructure/scheduler.ts';
import { FileSnapshotRepository } from '#infrastructure/snapshots/snapshot-files.ts';
import { backupRoutes } from '#presentation/backups/routes.ts';
import http from 'node:http';
import { LoadProject } from '#application/project/load-project.ts';
import { ResolveCaller } from '#application/sign-in/resolve-caller.ts';
import { WatchChanges } from '#application/project/watch-changes.ts';
import { StoreChangeFeed } from '#infrastructure/json-store/store-change-feed.ts';
import { MissingRecordError, RejectedChangeError } from '#infrastructure/json-store/store.ts';
import type { HttpFailure } from '#presentation/http/errors.ts';
import type { TrustProxy } from '#presentation/http/pipeline/client-address.ts';
import { requestPipeline } from '#presentation/http/pipeline/pipeline.ts';
import { Security } from '#presentation/http/pipeline/security.ts';

export interface AuthOptions {
  /** The time, in milliseconds since the epoch; tests pass their own clock. */
  readonly now?: () => number;
  /** Force sign-in off whatever its settings say (AUTH_DISABLED): recovery if every admin is locked out. */
  readonly disabled?: boolean;
}

/** Sign-in for one data directory: its adapters, and what the rest of the app reads from it. */
export interface Auth {
  readonly deps: Pick<SignInDeps, 'accounts' | 'signInSettings' | 'sessions' | 'failedAttempts' | 'apiTokens' | 'hasher' | 'secrets' | 'signInWrites' | 'signInForcedOff'> & {
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
      signInWrites: store.writes,
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

export interface CreateAppOptions {
  readonly store: Store;
  /** The built client to serve, if any. */
  readonly staticDir?: string | undefined;
  /**
   * Set when running behind a reverse proxy (e.g. Caddy), so the app sees clients' addresses and
   * the original HTTPS scheme (and marks sign-in cookies as Secure). Same values as Express's
   * "trust proxy": true, a number of hops, or trusted addresses.
   */
  readonly trustProxy?: TrustProxy;
  /** Rate limits and abuse protection; pass false to turn them off (tests). */
  readonly security?: Security | false;
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
    snapshots: new FileSnapshotRepository(store.dataDir),
    project: new StoreProject(store),
    changes: new StoreChangeFeed(store),
    github: new FileGitHubIntegrationRepository(new IntegrationsFile(store.dataDir)),
    deliveries: new MemoryDeliveryLog(),
    webhookSignatures: new HmacSignatures(),
    githubPayloads: new GitHubPayloadReader(),
    integrationWrites: new SerialQueue(),
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
    removeDevLink: new RemoveDevLink(deps),
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
  const integrations = integrationRoutes({
    identify,
    getWebhookStatus: new GetWebhookStatus(deps),
    receiveGitHubDelivery: new ReceiveGitHubDelivery(deps),
    getGitHubAdminView: new GetGitHubAdminView(deps),
    updateGitHubSettings: new UpdateGitHubSettings(deps),
    rotateWebhookSecret: new RotateWebhookSecret(deps),
  });
  const backups = backupRoutes({
    identify,
    heavyOperation: context.heavyOperation,
    listSnapshots: new ListSnapshots(deps),
    takeSnapshot: new TakeSnapshot(deps),
    updateSnapshot: new UpdateSnapshot(deps),
    deleteSnapshot: new DeleteSnapshot(deps),
    restoreSnapshot: new RestoreSnapshot(deps),
    downloadSnapshot: new DownloadSnapshot(deps),
    exportBackup: new ExportBackup(deps),
    importBackup: new ImportBackup(deps),
    resetProject: new ResetProject(deps),
  });
  return combineRoutes(signIn, workItems, team, integrations, backups);
}

/** How often the server checks whether a scheduled snapshot is due. */
const BACKUP_CHECK_MS = 10 * 60_000;

/** Errors adapters throw that mean something to the caller. */
function describeStoreError(error: unknown): HttpFailure | undefined {
  if (error instanceof MissingRecordError) return { status: 404, message: error.message };
  if (error instanceof RejectedChangeError) return { status: 400, message: error.message };
  return undefined;
}

export interface ComposedApp {
  /** The HTTP server, not yet listening. */
  readonly app: http.Server;
  /** Take scheduled snapshots when due, checking now and every 10 minutes. Returns a function that stops it. */
  startBackupSchedule(): () => void;
}

/** The whole app as an HTTP server (not yet listening). */
export function createApp(options: CreateAppOptions) {
  return composeApp(options).app;
}

/** The app, and the background work that comes with it. */
export function composeApp(options: CreateAppOptions): ComposedApp {
  const { events = new LocalEventBus(), auth = createAuth(options.store), security = new Security() } = options;
  const deps = composeDeps(options.store, auth, events);
  // Sign-in keeps its own clock, so tests can move time for sessions, lockouts and expiry alone.
  const signInDeps: SignInDeps = { ...deps, clock: auth.deps.clock };
  const authenticator = new Authenticator(new IdentifyCaller(signInDeps));
  const handler = requestPipeline({
    routes: (context) => composeRoutes(deps, signInDeps, context),
    authenticator,
    signInEnabled: () => auth.enabled,
    resolveCaller: new ResolveCaller(deps),
    loadProject: new LoadProject(deps),
    watchChanges: new WatchChanges(deps),
    security,
    trustProxy: options.trustProxy,
    staticDir: options.staticDir,
    describeError: describeStoreError,
  });
  const app = http.createServer(handler);
  const scheduled = new TakeScheduledSnapshot(deps);
  return {
    app,
    startBackupSchedule: () => runEvery(BACKUP_CHECK_MS, () => scheduled.execute(), (error) => console.error('Automatic snapshot failed', error)),
  };
}
