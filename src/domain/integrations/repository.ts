import type { GitHubIntegration } from './github.ts';

/** The GitHub integration's settings and secret, kept apart from the project data. */
export interface GitHubIntegrationRepository {
  get(): Promise<GitHubIntegration>;
  save(integration: GitHubIntegration): Promise<void>;
}
