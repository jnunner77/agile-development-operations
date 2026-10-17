import { GitHubSettingsChanges, type GitHubSettingsError, type GitHubSettingsInput } from '#domain/integrations/github.ts';
import { ok, type Result } from '#shared/result.ts';
import { requireAdmin, type AccessError } from '../access.ts';
import type { Caller } from '../caller.ts';
import type { GitHubAdminView } from '../contracts/integrations.ts';
import { adminView, type IntegrationDeps } from './deps.ts';

export interface UpdateGitHubSettingsInput extends GitHubSettingsInput {
  readonly caller: Caller;
}

export class UpdateGitHubSettings {
  readonly #deps: IntegrationDeps;

  constructor(deps: IntegrationDeps) {
    this.#deps = deps;
  }

  async execute(input: UpdateGitHubSettingsInput): Promise<Result<GitHubAdminView, GitHubSettingsError | AccessError>> {
    const access = requireAdmin(input.caller);
    if (!access.ok) return access;
    const changes = GitHubSettingsChanges.validate(input);
    if (!changes.ok) return changes;
    const deps = this.#deps;
    const events = await deps.integrationWrites.run(async () => {
      const integration = await deps.github.get();
      integration.update(changes.value, deps.clock.now());
      await deps.github.save(integration);
      return integration.pullEvents();
    });
    await deps.events.publish(events);
    return ok(await adminView(deps));
  }
}
