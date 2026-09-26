import express, { type NextFunction, type Request, type Response } from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { z, ZodError } from 'zod';
import { HttpError, badRequest } from './errors';
import type { Store, Tx } from './store';
import type { SnapshotManager } from './snapshots';
import { emptyDatabase } from './schema';
import { buildDemoDatabase } from './seed';
import * as wi from './workitems';
import * as team from './team';

export interface AppOptions {
  store: Store;
  snapshots: SnapshotManager;
  staticDir?: string;
}

/** Resolve the display name of the caller from the X-User header (a member id or a name). */
function userName(store: Store, req: Request): string {
  const raw = req.header('x-user');
  if (!raw) return 'Anonymous';
  const value = decodeURIComponent(raw);
  return store.db.members.find((m) => m.id === value)?.name ?? value.slice(0, 128);
}

const intParam = (value: string | string[] | undefined) => {
  const n = Number(value);
  if (!Number.isInteger(n)) throw badRequest('Invalid id');
  return n;
};

export function createApp({ store, snapshots, staticDir }: AppOptions) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100mb' }));

  const api = express.Router();

  /** Wrap a mutation: run it in a transaction and reply with the resulting delta. */
  const mutate =
    <T>(fn: (tx: Tx, req: Request) => T, status = 200) =>
    (req: Request, res: Response) => {
      const { delta, result } = store.transact(userName(store, req), req.header('x-client-id'), (tx) => fn(tx, req));
      res.status(status).json({ delta, result });
    };

  api.get('/bootstrap', (_req, res) => {
    res.json({ db: store.db, serverTime: new Date().toISOString() });
  });

  // Server-sent events: every committed change is pushed to connected browsers.
  api.get('/events', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`event: hello\ndata: ${JSON.stringify({ version: store.db.version })}\n\n`);
    const unsubscribe = store.subscribe((delta, origin) => {
      res.write(`data: ${JSON.stringify({ delta, origin })}\n\n`);
    });
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  // ---- Work items -------------------------------------------------------------
  api.post(
    '/workitems',
    mutate((tx, req) => wi.createWorkItem(tx, wi.workItemCreateSchema.parse(req.body)), 201),
  );
  api.patch(
    '/workitems/:id',
    mutate((tx, req) => wi.updateWorkItem(tx, intParam(req.params.id), wi.workItemPatchSchema.parse(req.body))),
  );
  api.delete(
    '/workitems/:id',
    mutate((tx, req) => wi.deleteWorkItem(tx, intParam(req.params.id))),
  );
  api.post(
    '/workitems/:id/move',
    mutate((tx, req) => wi.moveWorkItem(tx, intParam(req.params.id), wi.moveSchema.parse(req.body))),
  );
  api.post(
    '/workitems/:id/copy',
    mutate(
      (tx, req) => wi.copyWorkItem(tx, intParam(req.params.id), z.object({ includeChildren: z.boolean().optional() }).parse(req.body ?? {}).includeChildren ?? false),
      201,
    ),
  );
  api.post(
    '/workitems/bulk',
    mutate((tx, req) => wi.bulkUpdate(tx, wi.bulkSchema.parse(req.body))),
  );
  api.post(
    '/workitems/bulk-delete',
    mutate((tx, req) => {
      const { ids } = z.object({ ids: z.array(z.number().int()).min(1) }).parse(req.body);
      for (const id of ids) if (tx.db.workItems.some((w) => w.id === id)) wi.deleteWorkItem(tx, id);
    }),
  );
  api.post(
    '/workitems/:id/comments',
    mutate((tx, req) => wi.addComment(tx, intParam(req.params.id), wi.commentSchema.parse(req.body).text), 201),
  );
  api.patch(
    '/workitems/:id/comments/:commentId',
    mutate((tx, req) => wi.editComment(tx, intParam(req.params.id), String(req.params.commentId), wi.commentSchema.parse(req.body).text)),
  );
  api.delete(
    '/workitems/:id/comments/:commentId',
    mutate((tx, req) => wi.deleteComment(tx, intParam(req.params.id), String(req.params.commentId))),
  );
  api.post(
    '/workitems/:id/hyperlinks',
    mutate((tx, req) => wi.addHyperlink(tx, intParam(req.params.id), wi.hyperlinkSchema.parse(req.body)), 201),
  );
  api.delete(
    '/workitems/:id/hyperlinks/:linkId',
    mutate((tx, req) => wi.removeHyperlink(tx, intParam(req.params.id), String(req.params.linkId))),
  );

  api.post(
    '/links',
    mutate((tx, req) => wi.addLink(tx, wi.linkSchema.parse(req.body)), 201),
  );
  api.delete(
    '/links/:id',
    mutate((tx, req) => wi.removeLink(tx, String(req.params.id))),
  );

  api.post(
    '/recycle-bin/:id/restore',
    mutate((tx, req) => wi.restoreWorkItem(tx, intParam(req.params.id))),
  );
  api.delete(
    '/recycle-bin/:id',
    mutate((tx, req) => wi.purgeWorkItem(tx, intParam(req.params.id))),
  );

  // ---- Sprints & capacity -----------------------------------------------------
  api.post(
    '/sprints',
    mutate((tx, req) => team.createSprint(tx, team.sprintSchema.parse(req.body)), 201),
  );
  api.patch(
    '/sprints/:id',
    mutate((tx, req) => team.updateSprint(tx, String(req.params.id), team.sprintSchema.parse(req.body))),
  );
  api.delete(
    '/sprints/:id',
    mutate((tx, req) => {
      const moveTo = typeof req.query.moveTo === 'string' && req.query.moveTo ? req.query.moveTo : null;
      team.deleteSprint(tx, String(req.params.id), moveTo);
    }),
  );
  api.put(
    '/sprints/:id/capacity',
    mutate((tx, req) => team.setCapacity(tx, String(req.params.id), team.capacitySchema.parse(req.body))),
  );
  api.post(
    '/sprints/:id/capacity/copy',
    mutate((tx, req) => team.copyCapacity(tx, String(req.params.id), z.object({ fromSprintId: z.string() }).parse(req.body).fromSprintId)),
  );

  // ---- Team & settings --------------------------------------------------------
  api.post(
    '/members',
    mutate((tx, req) => team.createMember(tx, team.memberSchema.parse(req.body)), 201),
  );
  api.patch(
    '/members/:id',
    mutate((tx, req) => team.updateMember(tx, String(req.params.id), team.memberSchema.parse(req.body))),
  );
  api.delete(
    '/members/:id',
    mutate((tx, req) => team.deleteMember(tx, String(req.params.id))),
  );
  api.patch(
    '/settings',
    mutate((tx, req) => team.updateSettings(tx, team.settingsSchema.parse(req.body))),
  );

  // ---- Snapshots & backups ----------------------------------------------------
  const snapshotInput = z.object({ name: z.string().trim().max(200).optional(), description: z.string().max(2000).optional() }).strict();

  api.get('/snapshots', (_req, res) => {
    res.json(snapshots.list());
  });
  api.post('/snapshots', (req, res) => {
    const input = snapshotInput.parse(req.body ?? {});
    res.status(201).json(snapshots.create(input.name ?? '', input.description ?? '', 'manual', userName(store, req)));
  });
  api.patch('/snapshots/:id', (req, res) => {
    res.json(snapshots.update(String(req.params.id), snapshotInput.parse(req.body)));
  });
  api.delete('/snapshots/:id', (req, res) => {
    snapshots.delete(String(req.params.id));
    res.status(204).end();
  });
  api.post('/snapshots/:id/restore', (req, res) => {
    const safety = snapshots.restore(String(req.params.id), userName(store, req), req.header('x-client-id'));
    res.json({ safetySnapshot: safety });
  });
  api.get('/snapshots/:id/download', (req, res) => {
    const file = snapshots.filePath(String(req.params.id));
    res.download(file, `snapshot-${req.params.id}.json`);
  });

  api.get('/backup/export', (req, res) => {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const slug = store.db.settings.projectName.replace(/[^\w-]+/g, '-').toLowerCase();
    res.setHeader('Content-Disposition', `attachment; filename="${slug}-backup-${stamp}.json"`);
    res.json({
      format: 'ado-clone-backup',
      exportedAt: new Date().toISOString(),
      exportedBy: userName(store, req),
      data: store.db,
    });
  });
  api.post('/backup/import', (req, res) => {
    try {
      const safety = snapshots.import(req.body, userName(store, req), req.header('x-client-id'));
      res.json({ safetySnapshot: safety });
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw badRequest(err instanceof Error ? err.message : 'Invalid backup file');
    }
  });
  api.post('/backup/reset', (req, res) => {
    const { mode } = z.object({ mode: z.enum(['empty', 'demo']) }).parse(req.body);
    const safety = snapshots.create('Before reset', `Automatic safety snapshot taken before resetting to ${mode === 'demo' ? 'demo data' : 'an empty project'}`, 'pre-reset', userName(store, req));
    const settings = { ...store.db.settings };
    const next = mode === 'demo' ? buildDemoDatabase() : emptyDatabase({ projectName: settings.projectName, teamName: settings.teamName, backup: settings.backup, workingDays: settings.workingDays, areaPaths: settings.areaPaths });
    store.replace(next, req.header('x-client-id'));
    res.json({ safetySnapshot: safety });
  });

  api.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  app.use('/api', api);

  if (staticDir && fs.existsSync(staticDir)) {
    app.use(express.static(staticDir, { index: false }));
    app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(staticDir, 'index.html')));
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) {
      const issue = err.issues[0];
      const where = issue?.path.length ? `${issue.path.join('.')}: ` : '';
      return res.status(400).json({ error: `${where}${issue?.message ?? 'Invalid request'}` });
    }
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err instanceof SyntaxError && 'body' in (err as object)) return res.status(400).json({ error: 'Malformed JSON' });
    if ((err as { type?: string })?.type === 'entity.too.large') return res.status(413).json({ error: 'Request is too large' });
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
