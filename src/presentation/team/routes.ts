import type { UpdateSettings } from '#application/settings/update-settings.ts';
import type { CopyCapacity } from '#application/sprints/copy-capacity.ts';
import type { CreateSprint } from '#application/sprints/create-sprint.ts';
import type { DeleteSprint } from '#application/sprints/delete-sprint.ts';
import type { SetCapacity } from '#application/sprints/set-capacity.ts';
import type { UpdateSprint } from '#application/sprints/update-sprint.ts';
import type { CreateMember } from '#application/team/create-member.ts';
import type { DeleteMember } from '#application/team/delete-member.ts';
import type { UpdateMember } from '#application/team/update-member.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { requireAdmin } from '#application/access.ts';
import type { Caller } from '#application/caller.ts';
import type { CallerResolver } from '../http/caller.ts';
import { fail, input, queryParam, reply } from '../http/handlers.ts';
import { Router, type Params } from '../http/router.ts';
import { parseCapacity, parseCopyCapacity, parseMember, parseSettings, parseSprint } from './parsers.ts';

export interface TeamRouteDeps {
  readonly identify: CallerResolver;
  readonly createSprint: Pick<CreateSprint, 'execute'>;
  readonly updateSprint: Pick<UpdateSprint, 'execute'>;
  readonly deleteSprint: Pick<DeleteSprint, 'execute'>;
  readonly setCapacity: Pick<SetCapacity, 'execute'>;
  readonly copyCapacity: Pick<CopyCapacity, 'execute'>;
  readonly createMember: Pick<CreateMember, 'execute'>;
  readonly updateMember: Pick<UpdateMember, 'execute'>;
  readonly deleteMember: Pick<DeleteMember, 'execute'>;
  readonly updateSettings: Pick<UpdateSettings, 'execute'>;
}

/** Sprint, capacity, team member and project settings routes, relative to /api. */
export function teamRoutes(deps: TeamRouteDeps): Router {
  const { identify } = deps;

  /** Team and settings changes turn away non-administrators before reading what they sent. */
  const adminOnly =
    (handle: (req: IncomingMessage, res: ServerResponse, params: Params, caller: Caller) => Promise<void>) =>
    async (req: IncomingMessage, res: ServerResponse, params: Params) => {
      const caller = identify(req, res);
      const access = requireAdmin(caller);
      if (!access.ok) return fail(res, access.error);
      return handle(req, res, params, caller);
    };

  return new Router()
    .add('POST', '/sprints', async (req, res) => {
      const body = await input(req, res, parseSprint);
      if (body.ok) await reply(res, deps.createSprint.execute({ caller: identify(req, res), ...body.value }), 201);
    })
    .add('PATCH', '/sprints/:id', async (req, res, params) => {
      const body = await input(req, res, parseSprint);
      if (body.ok) await reply(res, deps.updateSprint.execute({ caller: identify(req, res), id: params['id'] ?? '', ...body.value }), 200);
    })
    .add('DELETE', '/sprints/:id', async (req, res, params) => {
      const moveTo = queryParam(req, 'moveTo');
      await reply(res, deps.deleteSprint.execute({ caller: identify(req, res), id: params['id'] ?? '', moveTo }), 200);
    })
    .add('PUT', '/sprints/:id/capacity', async (req, res, params) => {
      const body = await input(req, res, parseCapacity);
      if (body.ok) await reply(res, deps.setCapacity.execute({ caller: identify(req, res), sprintId: params['id'] ?? '', ...body.value }), 200);
    })
    .add('POST', '/sprints/:id/capacity/copy', async (req, res, params) => {
      const body = await input(req, res, parseCopyCapacity);
      if (body.ok) await reply(res, deps.copyCapacity.execute({ caller: identify(req, res), sprintId: params['id'] ?? '', ...body.value }), 200);
    })
    .add(
      'POST',
      '/members',
      adminOnly(async (req, res, _params, caller) => {
        const body = await input(req, res, parseMember);
        if (body.ok) await reply(res, deps.createMember.execute({ caller, ...body.value }), 201);
      }),
    )
    .add(
      'PATCH',
      '/members/:id',
      adminOnly(async (req, res, params, caller) => {
        const body = await input(req, res, parseMember);
        if (body.ok) await reply(res, deps.updateMember.execute({ caller, id: params['id'] ?? '', ...body.value }), 200);
      }),
    )
    .add(
      'DELETE',
      '/members/:id',
      adminOnly(async (_req, res, params, caller) => {
        await reply(res, deps.deleteMember.execute({ caller, id: params['id'] ?? '' }), 200);
      }),
    )
    .add(
      'PATCH',
      '/settings',
      adminOnly(async (req, res, _params, caller) => {
        const body = await input(req, res, parseSettings);
        if (body.ok) await reply(res, deps.updateSettings.execute({ caller, ...body.value }), 200);
      }),
    );
}
