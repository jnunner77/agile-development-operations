import type { ApiTokenEvent } from './api-tokens/api-token.ts';
import type { LinkEvent } from './links/link.ts';
import type { AccountEvent } from './sign-in/account.ts';
import type { SignInSettingsEvent } from './sign-in/settings.ts';
import type { RecycleBinEvent } from './recycle-bin/deleted-work-item.ts';
import type { SettingsEvent } from './settings/project-settings.ts';
import type { CapacityEvent } from './sprints/capacity-plan.ts';
import type { SprintEvent } from './sprints/sprint.ts';
import type { MemberEvent } from './team/member.ts';
import type { WorkItemEvent } from './work-items/events.ts';

/** Everything the domain reports as having happened. */
export type DomainEvent = WorkItemEvent | LinkEvent | RecycleBinEvent | SprintEvent | CapacityEvent | MemberEvent | SettingsEvent | AccountEvent | SignInSettingsEvent | ApiTokenEvent;
