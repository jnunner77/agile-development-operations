import type { IncomingMessage, ServerResponse } from 'node:http';
import { requireAdmin } from '#application/access.ts';
import type { Caller } from '#application/caller.ts';
import type { GetGitHubAdminView } from '#application/integrations/get-github-admin-view.ts';
import type { GetWebhookStatus } from '#application/integrations/get-webhook-status.ts';
import type { ReceiveGitHubDelivery } from '#application/integrations/receive-github-delivery.ts';
import type { RotateWebhookSecret } from '#application/integrations/rotate-webhook-secret.ts';
import type { UpdateGitHubSettings } from '#application/integrations/update-github-settings.ts';
import { readRawBody } from '../http/body.ts';
import type { CallerResolver } from '../http/caller.ts';
import { fail, input, respond } from '../http/handlers.ts';
import { sendError } from '../http/respond.ts';
import { Router, type Params } from '../http/router.ts';
import { parseGitHubSettings } from './parsers.ts';

/** Largest webhook delivery accepted (GitHub caps payloads at 25 MB; pushes are far smaller). */
export const WEBHOOK_LIMIT_BYTES = 10 * 1024 * 1024;

export interface IntegrationRouteDeps {
  readonly identify: CallerResolver;
  readonly getWebhookStatus: Pick<GetWebhookStatus, 'execute'>;
  readonly receiveGitHubDelivery: Pick<ReceiveGitHubDelivery, 'execute'>;
  readonly getGitHubAdminView: Pick<GetGitHubAdminView, 'execute'>;
  readonly updateGitHubSettings: Pick<UpdateGitHubSettings, 'execute'>;
  readonly rotateWebhookSecret: Pick<RotateWebhookSecret, 'execute'>;
}

/** A header sent exactly once, else undefined. */
function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === 'string' ? value : undefined;
}

/** The GitHub webhook and the integration's settings, relative to /api. */
export function integrationRoutes(deps: IntegrationRouteDeps): Router {
  const { identify } = deps;

  const adminOnly =
    (handle: (req: IncomingMessage, res: ServerResponse, params: Params, caller: Caller) => Promise<void>) =>
    async (req: IncomingMessage, res: ServerResponse, params: Params) => {
      const caller = identify(req, res);
      const access = requireAdmin(caller);
      if (!access.ok) return fail(res, access.error);
      return handle(req, res, params, caller);
    };

  return new Router()
    .add('POST', '/integrations/github/webhook', async (req, res) => {
      // Authenticated by its signature, not a session. Turn away what can't be a delivery before
      // reading the body, so nobody can make the server read a large body for nothing.
      if (!(await deps.getWebhookStatus.execute()).open) return sendError(res, 404, 'Webhook not found');
      const signature = header(req, 'x-hub-signature-256');
      if (!signature?.startsWith('sha256=')) return sendError(res, 401, 'Invalid signature');
      const event = header(req, 'x-github-event');
      if (!event) return sendError(res, 400, 'Missing X-GitHub-Event header');
      const body = await readRawBody(req, WEBHOOK_LIMIT_BYTES);
      if (!body.ok) return sendError(res, 413, 'Request is too large');
      const deliveryId = header(req, 'x-github-delivery') ?? null;
      respond(res, await deps.receiveGitHubDelivery.execute({ deliveryId, event, signature, body: body.value }));
    })
    .add(
      'GET',
      '/integrations/github',
      adminOnly(async (_req, res, _params, caller) => respond(res, await deps.getGitHubAdminView.execute({ caller }))),
    )
    .add(
      'PUT',
      '/integrations/github',
      adminOnly(async (req, res, _params, caller) => {
        const body = await input(req, res, parseGitHubSettings);
        if (body.ok) respond(res, await deps.updateGitHubSettings.execute({ caller, ...body.value }));
      }),
    )
    .add(
      'POST',
      '/integrations/github/secret',
      adminOnly(async (_req, res, _params, caller) => respond(res, await deps.rotateWebhookSecret.execute({ caller }))),
    );
}
