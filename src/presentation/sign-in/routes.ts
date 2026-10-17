import type { IncomingMessage, ServerResponse } from 'node:http';
import { requireAdmin } from '#application/access.ts';
import type { CreateApiToken } from '#application/api-tokens/create-api-token.ts';
import type { ListApiTokens } from '#application/api-tokens/list-api-tokens.ts';
import type { RevokeApiToken } from '#application/api-tokens/revoke-api-token.ts';
import type { Caller } from '#application/caller.ts';
import type { ChangePassword } from '#application/sign-in/change-password.ts';
import type { GetSignInAdminView } from '#application/sign-in/get-sign-in-admin-view.ts';
import type { GetSignInStatus } from '#application/sign-in/get-sign-in-status.ts';
import type { ResetPassword } from '#application/sign-in/reset-password.ts';
import type { SetAdministrator } from '#application/sign-in/set-administrator.ts';
import type { SetPassword } from '#application/sign-in/set-password.ts';
import type { SignIn } from '#application/sign-in/sign-in.ts';
import type { SignOut } from '#application/sign-in/sign-out.ts';
import type { UpdateSignInSettings } from '#application/sign-in/update-sign-in-settings.ts';
import { ok } from '#shared/result.ts';
import type { RequestContext } from '../http/context.ts';
import { fail, input, respond } from '../http/handlers.ts';
import { sendError, sendJson } from '../http/respond.ts';
import { Router, type Params } from '../http/router.ts';
import { clearedSessionCookie, sessionCookie } from './cookies.ts';
import { parseAdministrator, parseLogin, parseNewToken, parsePasswordChange, parseSetPassword, parseSignInSettings } from './parsers.ts';

export interface SignInRouteDeps {
  readonly context: RequestContext;
  readonly getSignInStatus: Pick<GetSignInStatus, 'execute'>;
  readonly signIn: Pick<SignIn, 'execute'>;
  readonly changePassword: Pick<ChangePassword, 'execute'>;
  readonly signOut: Pick<SignOut, 'execute'>;
  readonly getSignInAdminView: Pick<GetSignInAdminView, 'execute'>;
  readonly updateSignInSettings: Pick<UpdateSignInSettings, 'execute'>;
  readonly setAdministrator: Pick<SetAdministrator, 'execute'>;
  readonly setPassword: Pick<SetPassword, 'execute'>;
  readonly resetPassword: Pick<ResetPassword, 'execute'>;
  readonly listApiTokens: Pick<ListApiTokens, 'execute'>;
  readonly createApiToken: Pick<CreateApiToken, 'execute'>;
  readonly revokeApiToken: Pick<RevokeApiToken, 'execute'>;
}

type Handler = (req: IncomingMessage, res: ServerResponse, params: Params, caller: Caller) => Promise<void>;

/** Sign-in and API token routes, relative to /api. */
export function signInRoutes(deps: SignInRouteDeps): Router {
  const { context } = deps;

  /** API tokens can never manage sign-in or tokens; only the status is open to them. */
  const people =
    (handle: Handler) =>
    async (req: IncomingMessage, res: ServerResponse, params: Params): Promise<void> => {
      if (context.identity(req, res).identity.via === 'token') return sendError(res, 403, "API tokens can't be used to manage sign-in or tokens");
      return handle(req, res, params, context.caller(req, res));
    };

  /** Administration turns everyone else away before reading what they sent. */
  const admins = (handle: Handler) =>
    people(async (req, res, params, caller) => {
      const access = requireAdmin(caller);
      if (!access.ok) return fail(res, access.error);
      return handle(req, res, params, caller);
    });

  const signedIn = (req: IncomingMessage, res: ServerResponse, sessionToken: string) =>
    res.setHeader('Set-Cookie', sessionCookie(sessionToken, context.secure(req, res)));

  return new Router()
    .add('GET', '/auth/status', async (req, res) => {
      sendJson(res, 200, await deps.getSignInStatus.execute({ member: context.identity(req, res).identity.member }));
    })
    .add(
      'POST',
      '/auth/login',
      people(async (req, res) => {
        const body = await input(req, res, parseLogin);
        if (!body.ok) return;
        const result = await deps.signIn.execute(body.value);
        if (result.ok && result.value.sessionToken) signedIn(req, res, result.value.sessionToken);
        respond(res, result.ok ? ok(result.value.result) : result);
      }),
    )
    .add(
      'POST',
      '/auth/password',
      people(async (req, res) => {
        const body = await input(req, res, parsePasswordChange);
        if (!body.ok) return;
        const result = await deps.changePassword.execute(body.value);
        if (result.ok) signedIn(req, res, result.value.sessionToken);
        respond(res, result.ok ? ok({ status: 'ok', user: result.value.user }) : result);
      }),
    )
    .add(
      'POST',
      '/auth/logout',
      people(async (req, res) => {
        await deps.signOut.execute({ sessionToken: context.identity(req, res).sessionToken });
        res.setHeader('Set-Cookie', clearedSessionCookie());
        res.writeHead(204).end();
      }),
    )
    .add(
      'GET',
      '/auth/admin',
      admins(async (_req, res, _params, caller) => respond(res, await deps.getSignInAdminView.execute({ caller }))),
    )
    .add(
      'PUT',
      '/auth/settings',
      admins(async (req, res, _params, caller) => {
        const body = await input(req, res, parseSignInSettings);
        if (body.ok) respond(res, await deps.updateSignInSettings.execute({ caller, ...body.value }));
      }),
    )
    .add(
      'PATCH',
      '/auth/accounts/:memberId',
      admins(async (req, res, params, caller) => {
        const body = await input(req, res, parseAdministrator);
        if (body.ok) respond(res, await deps.setAdministrator.execute({ caller, memberId: params['memberId'] ?? '', isAdmin: body.value.isAdmin }));
      }),
    )
    .add(
      'POST',
      '/auth/accounts/:memberId/password',
      admins(async (req, res, params, caller) => {
        const body = await input(req, res, parseSetPassword);
        if (body.ok) respond(res, await deps.setPassword.execute({ caller, memberId: params['memberId'] ?? '', ...body.value }));
      }),
    )
    .add(
      'POST',
      '/auth/accounts/:memberId/reset',
      admins(async (_req, res, params, caller) => respond(res, await deps.resetPassword.execute({ caller, memberId: params['memberId'] ?? '' }))),
    )
    .add(
      'GET',
      '/auth/tokens',
      people(async (_req, res, _params, caller) => sendJson(res, 200, await deps.listApiTokens.execute({ caller }))),
    )
    .add(
      'POST',
      '/auth/tokens',
      people(async (req, res, _params, caller) => {
        const body = await input(req, res, parseNewToken);
        if (body.ok) respond(res, await deps.createApiToken.execute({ caller, ...body.value }), 201);
      }),
    )
    .add(
      'DELETE',
      '/auth/tokens/:id',
      people(async (_req, res, params, caller) => {
        const revoked = await deps.revokeApiToken.execute({ caller, id: params['id'] ?? '' });
        if (revoked.ok) res.writeHead(204).end();
        else fail(res, revoked.error);
      }),
    );
}
