import type { IntegrationDeps } from './deps.ts';

/**
 * Whether the webhook takes deliveries (it is on and has a secret). Asked before a delivery's
 * body is read, so nobody can make the server read a large body for nothing.
 */
export class GetWebhookStatus {
  readonly #deps: Pick<IntegrationDeps, 'github'>;

  constructor(deps: Pick<IntegrationDeps, 'github'>) {
    this.#deps = deps;
  }

  async execute(): Promise<{ readonly open: boolean }> {
    return { open: (await this.#deps.github.get()).webhookSecret !== null };
  }
}
