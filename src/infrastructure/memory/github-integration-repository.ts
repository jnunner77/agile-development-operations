import { GitHubIntegration, type GitHubIntegrationData } from '#domain/integrations/github.ts';
import type { GitHubIntegrationRepository } from '#domain/integrations/repository.ts';

/** The GitHub integration in memory, for tests. */
export class MemoryGitHubIntegrationRepository implements GitHubIntegrationRepository {
  #data: Partial<GitHubIntegrationData>;

  constructor(initial: Partial<GitHubIntegrationData> = {}) {
    this.#data = { ...initial };
  }

  async get(): Promise<GitHubIntegration> {
    return GitHubIntegration.reconstitute(this.#data);
  }

  async save(integration: GitHubIntegration): Promise<void> {
    this.#data = integration.toSnapshot();
  }

  snapshot(): Partial<GitHubIntegrationData> {
    return { ...this.#data };
  }
}
