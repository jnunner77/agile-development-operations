import type { IncomingMessage, ServerResponse } from 'node:http';
import { pipeline } from 'node:stream/promises';
import { requireAdmin } from '#application/access.ts';
import type { DeleteSnapshot } from '#application/backups/delete-snapshot.ts';
import type { DownloadSnapshot } from '#application/backups/download-snapshot.ts';
import type { ExportBackup } from '#application/backups/export-backup.ts';
import type { ImportBackup } from '#application/backups/import-backup.ts';
import type { ListSnapshots } from '#application/backups/list-snapshots.ts';
import type { ResetProject } from '#application/backups/reset-project.ts';
import type { RestoreSnapshot } from '#application/backups/restore-snapshot.ts';
import type { TakeSnapshot } from '#application/backups/take-snapshot.ts';
import type { UpdateSnapshot } from '#application/backups/update-snapshot.ts';
import type { Caller } from '#application/caller.ts';
import { readJsonBody } from '../http/body.ts';
import type { CallerResolver } from '../http/caller.ts';
import { fail, input, respond } from '../http/handlers.ts';
import { sendError, sendJson } from '../http/respond.ts';
import { Router, type Params } from '../http/router.ts';
import { parseNewSnapshot, parseReset, parseSnapshotDetails } from './parsers.ts';

/** Largest backup an administrator may import (everything else is limited to 2 MB). */
export const IMPORT_LIMIT_BYTES = 50 * 1024 * 1024;

export interface BackupRouteDeps {
  readonly identify: CallerResolver;
  /** Counts snapshot and backup operations against the caller's limit; false once it has answered 429. */
  readonly heavyOperation: (req: IncomingMessage, res: ServerResponse) => boolean;
  readonly listSnapshots: Pick<ListSnapshots, 'execute'>;
  readonly takeSnapshot: Pick<TakeSnapshot, 'execute'>;
  readonly updateSnapshot: Pick<UpdateSnapshot, 'execute'>;
  readonly deleteSnapshot: Pick<DeleteSnapshot, 'execute'>;
  readonly restoreSnapshot: Pick<RestoreSnapshot, 'execute'>;
  readonly downloadSnapshot: Pick<DownloadSnapshot, 'execute'>;
  readonly exportBackup: Pick<ExportBackup, 'execute'>;
  readonly importBackup: Pick<ImportBackup, 'execute'>;
  readonly resetProject: Pick<ResetProject, 'execute'>;
}

type Handler = (req: IncomingMessage, res: ServerResponse, params: Params, caller: Caller) => Promise<void>;

/** `attachment; filename="…"`, for names made of safe characters only. */
const attachment = (fileName: string) => `attachment; filename="${fileName.replace(/[^\w.-]/g, '_')}"`;

/** Snapshot and backup routes, relative to /api. */
export function backupRoutes(deps: BackupRouteDeps): Router {
  const { identify } = deps;

  /** Administration turns everyone else away before anything else happens. */
  const adminOnly =
    (handle: Handler) =>
    async (req: IncomingMessage, res: ServerResponse, params: Params): Promise<void> => {
      const caller = identify(req, res);
      const access = requireAdmin(caller);
      if (!access.ok) return fail(res, access.error);
      return handle(req, res, params, caller);
    };

  /** Expensive operations count against the caller's limit before the request is read. */
  const heavy =
    (handle: Handler): Handler =>
    async (req, res, params, caller) => {
      if (deps.heavyOperation(req, res)) await handle(req, res, params, caller);
    };

  const anyone = (handle: Handler) => async (req: IncomingMessage, res: ServerResponse, params: Params) => handle(req, res, params, identify(req, res));

  return new Router()
    .add('GET', '/snapshots', async (_req, res) => sendJson(res, 200, await deps.listSnapshots.execute()))
    .add(
      'POST',
      '/snapshots',
      anyone(
        heavy(async (req, res, _params, caller) => {
          const body = await input(req, res, parseNewSnapshot);
          if (body.ok) respond(res, await deps.takeSnapshot.execute({ caller, ...body.value }), 201);
        }),
      ),
    )
    .add(
      'PATCH',
      '/snapshots/:id',
      adminOnly(async (req, res, params, caller) => {
        const body = await input(req, res, parseSnapshotDetails);
        if (body.ok) respond(res, await deps.updateSnapshot.execute({ caller, id: params['id'] ?? '', ...body.value }));
      }),
    )
    .add(
      'DELETE',
      '/snapshots/:id',
      adminOnly(async (_req, res, params, caller) => {
        const result = await deps.deleteSnapshot.execute({ caller, id: params['id'] ?? '' });
        if (result.ok) res.writeHead(204).end();
        else fail(res, result.error);
      }),
    )
    .add(
      'POST',
      '/snapshots/:id/restore',
      adminOnly(heavy(async (_req, res, params, caller) => respond(res, await deps.restoreSnapshot.execute({ caller, id: params['id'] ?? '' })))),
    )
    .add(
      'GET',
      '/snapshots/:id/download',
      anyone(
        heavy(async (_req, res, params) => {
          const result = await deps.downloadSnapshot.execute({ id: params['id'] ?? '' });
          if (!result.ok) return fail(res, result.error);
          res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Disposition': attachment(result.value.fileName),
          });
          await pipeline(result.value.contents, res);
        }),
      ),
    )
    .add(
      'GET',
      '/backup/export',
      anyone(
        heavy(async (_req, res, _params, caller) => {
          const backup = await deps.exportBackup.execute({ caller });
          res.setHeader('Content-Disposition', attachment(backup.fileName));
          sendJson(res, 200, backup.file);
        }),
      ),
    )
    .add(
      'POST',
      '/backup/import',
      adminOnly(
        heavy(async (req, res, _params, caller) => {
          // Only here, after the caller is known to be an administrator, may a body be this large.
          const body = await readJsonBody(req, IMPORT_LIMIT_BYTES);
          if (!body.ok) return body.error.code === 'BODY_TOO_LARGE' ? sendError(res, 413, 'Request is too large') : sendError(res, 400, 'Malformed JSON');
          respond(res, await deps.importBackup.execute({ caller, file: body.value }));
        }),
      ),
    )
    .add(
      'POST',
      '/backup/reset',
      adminOnly(
        heavy(async (req, res, _params, caller) => {
          const body = await input(req, res, parseReset);
          if (body.ok) respond(res, await deps.resetProject.execute({ caller, mode: body.value.mode }));
        }),
      ),
    );
}
