import type { LinkError } from '#domain/links/link.ts';
import type { LinkRepository } from '#domain/links/repository.ts';
import type { RecycleBinError } from '#domain/recycle-bin/deleted-work-item.ts';
import type { RecycleBinRepository } from '#domain/recycle-bin/repository.ts';
import type { WorkItemError } from '#domain/work-items/errors.ts';
import type { WorkItemRepository } from '#domain/work-items/repository.ts';
import type { Clock, EventPublisher, IdGenerator, ProjectDirectory, UnitOfWork } from '../ports.ts';

export interface WorkItemDeps {
  readonly items: WorkItemRepository;
  readonly links: LinkRepository;
  readonly recycleBin: RecycleBinRepository;
  readonly project: ProjectDirectory;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly events: EventPublisher;
  readonly unitOfWork: UnitOfWork;
}

/** Every error a work item use case can return. */
export type WorkItemsError = WorkItemError | LinkError | RecycleBinError;
