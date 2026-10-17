import { ok, type Result } from '#shared/result.ts';
import { requireAdmin, type AccessError } from '../access.ts';
import type { Caller } from '../caller.ts';
import type { GitHubAdminView } from '../contracts/integrations.ts';
import { adminView, type IntegrationDeps } from './deps.ts';

/** A new webhook secret, shown this once; only the integrations file keeps it. */
export interface RotatedSecret {
  readonly secret: string;
  readonly view: GitHubAdminView;
}

export class RotateWebhookSecret {
  readonly #deps: IntegrationDeps;

  constructor(deps: IntegrationDeps) {
    this.#deps = deps;
  }

  async execute(input: { readonly caller: Caller }): Promise<Result<RotatedSecret, AccessError>> {
    const access = requireAdmin(input.caller);
    if (!access.ok) return access;
    const deps = this.#deps;
    const secret = deps.webhookSignatures.newSecret();
    const events = await deps.integrationWrites.run(async () => {
      const integration = await deps.github.get();
      integration.rotateSecret(secret, deps.clock.now());
      await deps.github.save(integration);
      return integration.pullEvents();
    });
    await deps.events.publish(events);
    return ok({ secret, view: await adminView(deps) });
  }
}
