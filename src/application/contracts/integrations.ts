/** Types shared by the GitHub integration's server code and its settings page. */

import type { GitHubSettings } from '#domain/integrations/github.ts';

export { DEFAULT_GITHUB_SETTINGS } from '#domain/integrations/github.ts';
export type { GitHubSettings } from '#domain/integrations/github.ts';

/** Where GitHub sends webhook deliveries. */
export const WEBHOOK_PATH = '/api/integrations/github/webhook';

export interface Delivery {
  id: string;
  event: string;
  repo: string;
  receivedAt: string;
  result: string;
  linked: number[];
  ok: boolean;
}

export interface GitHubAdminView {
  settings: GitHubSettings;
  hasSecret: boolean;
  webhookPath: string;
  deliveries: Delivery[];
}
