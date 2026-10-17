import type { LinkRepository } from '#domain/links/repository.ts';
import type { RecycleBinRepository } from '#domain/recycle-bin/repository.ts';
import type { SettingsRepository } from '#domain/settings/repository.ts';
import type { CapacityRepository, SprintRepository } from '#domain/sprints/repository.ts';
import type { MemberRepository } from '#domain/team/repository.ts';
import type { WorkItemRepository } from '#domain/work-items/repository.ts';
import type { AdminSafeguard, Clock, EventPublisher, IdGenerator, UnitOfWork } from './ports.ts';

/** Everything the use cases can depend on. Each module takes the part it needs. */
export interface AppDeps {
  readonly items: WorkItemRepository;
  readonly links: LinkRepository;
  readonly recycleBin: RecycleBinRepository;
  readonly sprints: SprintRepository;
  readonly capacities: CapacityRepository;
  readonly members: MemberRepository;
  readonly settings: SettingsRepository;
  readonly safeguard: AdminSafeguard;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly events: EventPublisher;
  readonly unitOfWork: UnitOfWork;
}

/** What every change needs: time, ids, events and a unit of work. */
export type ChangeDeps = Pick<AppDeps, 'clock' | 'ids' | 'events' | 'unitOfWork'>;
