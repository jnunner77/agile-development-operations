import { ok, type Result } from '#shared/result.ts';
import { requireAdmin, type AccessError } from '../access.ts';
import type { Caller } from '../caller.ts';
import type { GitHubAdminView } from '../contracts/integrations.ts';
import { adminView, type IntegrationDeps } from './deps.ts';

export class GetGitHubAdminView {
  readonly #deps: IntegrationDeps;

  constructor(deps: IntegrationDeps) {
    this.#deps = deps;
  }

  async execute(input: { readonly caller: Caller }): Promise<Result<GitHubAdminView, AccessError>> {
    const access = requireAdmin(input.caller);
    if (!access.ok) return access;
    return ok(await adminView(this.#deps));
  }
}
