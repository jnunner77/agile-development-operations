import type { LinkRepository } from '#domain/links/repository.ts';
import type { RecycleBinRepository } from '#domain/recycle-bin/repository.ts';
import type { SettingsRepository } from '#domain/settings/repository.ts';
import type { CapacityRepository, SprintRepository } from '#domain/sprints/repository.ts';
import type { MemberRepository } from '#domain/team/repository.ts';
import type { WorkItemRepository } from '#domain/work-items/repository.ts';
import type { ApiTokenRepository } from '#domain/api-tokens/repository.ts';
import type { GitHubIntegrationRepository } from '#domain/integrations/repository.ts';
import type { AccountRepository, FailedAttemptsRepository, SessionRepository, SignInSettingsRepository } from '#domain/sign-in/repository.ts';
import type { DeliveryLog, GitHubPayloads, WebhookSignatures } from './integrations/ports.ts';
import type { Clock, EventPublisher, IdGenerator, PasswordHasher, SerialWrites, Secrets, TeamDirectory, UnitOfWork } from './ports.ts';

/** Everything the use cases can depend on. Each module takes the part it needs. */
export interface AppDeps {
  readonly items: WorkItemRepository;
  readonly links: LinkRepository;
  readonly recycleBin: RecycleBinRepository;
  readonly sprints: SprintRepository;
  readonly capacities: CapacityRepository;
  readonly members: MemberRepository;
  readonly settings: SettingsRepository;
  readonly accounts: AccountRepository;
  readonly signInSettings: SignInSettingsRepository;
  readonly sessions: SessionRepository;
  readonly failedAttempts: FailedAttemptsRepository;
  readonly apiTokens: ApiTokenRepository;
  readonly team: TeamDirectory;
  readonly hasher: PasswordHasher;
  readonly secrets: Secrets;
  /** Account, settings and token changes run one at a time. */
  readonly signInWrites: SerialWrites;
  /** Sign-in is forced off (AUTH_DISABLED), whatever its settings say: recovery if every admin is locked out. */
  readonly signInForcedOff: boolean;
  readonly github: GitHubIntegrationRepository;
  readonly deliveries: DeliveryLog;
  readonly webhookSignatures: WebhookSignatures;
  readonly githubPayloads: GitHubPayloads;
  /** Integration settings and secret changes run one at a time. */
  readonly integrationWrites: SerialWrites;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly events: EventPublisher;
  readonly unitOfWork: UnitOfWork;
}

/** What every change needs: time, ids, events and a unit of work. */
export type ChangeDeps = Pick<AppDeps, 'clock' | 'ids' | 'events' | 'unitOfWork'>;
