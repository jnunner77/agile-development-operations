import type { LinkEvent } from './links/link.ts';
import type { RecycleBinEvent } from './recycle-bin/deleted-work-item.ts';
import type { WorkItemEvent } from './work-items/events.ts';

/** Everything the domain reports as having happened. */
export type DomainEvent = WorkItemEvent | LinkEvent | RecycleBinEvent;
