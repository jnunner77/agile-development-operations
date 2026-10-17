import type { GitHubSettingsError } from '#domain/integrations/github.ts';
import type { WorkItemError } from '#domain/work-items/errors.ts';
import type { AccessError } from '../access.ts';
import { WEBHOOK_PATH, type GitHubAdminView } from '../contracts/integrations.ts';
import type { AppDeps } from '../deps.ts';
import type { PayloadError } from './ports.ts';

export type IntegrationDeps = Pick<
  AppDeps,
  | 'github'
  | 'deliveries'
  | 'webhookSignatures'
  | 'githubPayloads'
  | 'integrationWrites'
  | 'secrets'
  | 'items'
  | 'sprints'
  | 'members'
  | 'clock'
  | 'ids'
  | 'events'
  | 'unitOfWork'
>;

export type WebhookError = { readonly code: 'WEBHOOK_CLOSED' } | { readonly code: 'INVALID_SIGNATURE' } | PayloadError;

/** Every error an integration use case can return. */
export type IntegrationsError = GitHubSettingsError | AccessError | WebhookError | WorkItemError;

/** What administrators see on the integrations page. Never the secret itself. */
export async function adminView(deps: Pick<IntegrationDeps, 'github' | 'deliveries'>): Promise<GitHubAdminView> {
  const integration = await deps.github.get();
  return { settings: integration.settings, hasSecret: integration.hasSecret, webhookPath: WEBHOOK_PATH, deliveries: deps.deliveries.recent() };
}
