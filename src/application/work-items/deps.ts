import type { LinkError } from '#domain/links/link.ts';
import type { RecycleBinError } from '#domain/recycle-bin/deleted-work-item.ts';
import type { WorkItemError } from '#domain/work-items/errors.ts';
import type { AppDeps } from '../deps.ts';

export type WorkItemDeps = Pick<
  AppDeps,
  'items' | 'links' | 'recycleBin' | 'sprints' | 'members' | 'settings' | 'clock' | 'ids' | 'events' | 'unitOfWork'
>;

/** Every error a work item use case can return. */
export type WorkItemsError = WorkItemError | LinkError | RecycleBinError;
