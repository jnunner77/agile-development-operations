import type { SettingsError } from '#domain/settings/project-settings.ts';
import type { AccessError } from './access.ts';
import type { IntegrationsError } from './integrations/deps.ts';
import type { ApiTokensError, SignInError } from './sign-in/deps.ts';
import type { SprintsError } from './sprints/deps.ts';
import type { TeamError } from './team/deps.ts';
import type { WorkItemsError } from './work-items/deps.ts';

/** Every error any use case can return. The delivery layer maps each code to a response. */
export type AppError = WorkItemsError | SprintsError | TeamError | SettingsError | AccessError | SignInError | ApiTokensError | IntegrationsError;
