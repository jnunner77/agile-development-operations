import express, { type NextFunction, type Request, type Response } from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { z, ZodError } from 'zod';
import { HttpError, badRequest } from './errors.ts';
import { adminAccessOf, mayModerateCommentsOf } from '#application/access.ts';
import type { Caller } from '#application/caller.ts';
import { MissingRecordError, RejectedChangeError, type Store, type Tx } from '#infrastructure/json-store/store.ts';
import type { RequestContext } from '#presentation/http/context.ts';
import type { Router } from '#presentation/http/router.ts';
import type { Authenticator, RequestIdentity } from '#presentation/sign-in/authenticator.ts';
import { gate } from '#presentation/sign-in/gate.ts';
import type { SnapshotManager } from './snapshots.ts';
import { emptyDatabase } from '#infrastructure/json-store/schema.ts';
import { buildDemoDatabase } from './seed.ts';
import { Security, retryAfterOf, securityHeaders } from './security.ts';
import { GitHubIntegration, WEBHOOK_PATH, githubSettingsSchema } from './github.ts';

/** Routes served by the layered code (src/), relative to /api. */
export type LayeredRoutes = Pick<Router, 'handle' | 'owns'>;

/** What the Express pipeline needs from sign-in, which lives in the layers. */
export interface SignInGlue {
  readonly authenticator: Pick<Authenticator, 'identify' | 'stillSignedIn'>;
  /** Whether sign-in is on now, for the per-request rate limits. */
  readonly enabled: boolean;
}

export interface AppOptions {
  store: Store;
  /** Builds the layered routes, given what the pipeline knows about each request. */
  layeredRoutes: (context: RequestContext) => LayeredRoutes;
  signIn: SignInGlue;
  snapshots: SnapshotManager;
  staticDir?: string;
  /**
   * Express "trust proxy" setting. Set it when running behind a reverse proxy (e.g. Caddy)
   * so the app sees the original HTTPS scheme and marks sign-in cookies as Secure.
   */
  trustProxy?: boolean | number | string | undefined;
  /** Rate limits and abuse protection; pass false to turn them off (tests). */
  security?: Security | false;
  /** Source control integration; one is created if omitted. */
  github?: GitHubIntegration;
}

/** Largest JSON body accepted, except for importing a backup (admins only). */
const JSON_LIMIT = '2mb';
const IMPORT_LIMIT = '50mb';

/** Resolve the display name of the caller from the X-User header (a member id or a name). */
function userName(store: Store, req: Request): string {
  const raw = req.header('x-user');
  if (!raw) return 'Anonymous';
  let value: string;
  try {
    value = decodeURIComponent(raw);
  } catch {
    return 'Anonymous'; // not valid percent-encoding: treat it as missing
  }
  return store.db.members.find((m) => m.id === value)?.name ?? value.slice(0, 128);
}

/**
 * The member making the request: the signed-in one or the API token's, else the one X-User names
 * (by id, or by a name only one member has).
 */
function callerId(store: Store, req: Request, res: Response): string | null {
  const member = identityOf(res).identity.member;
  if (member) return member.id;
  const raw = req.header('x-user');
  if (!raw) return null;
  let value: string;
  try {
    value = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (store.db.members.some((m) => m.id === value)) return value;
  const named = store.db.members.filter((m) => m.name === value);
  return named.length === 1 ? named[0].id : null;
}

const intParam = (value: string | string[] | undefined) => {
  const n = Number(value);
  if (!Number.isInteger(n)) throw badRequest('Invalid id');
  return n;
};

const ANONYMOUS: Caller = { name: 'Anonymous', memberId: null, mayModerateComments: false, admin: 'not-admin', origin: undefined };

/** Who the request comes from, as worked out by the identify middleware. */
function identityOf(res: Response): RequestIdentity {
  const found = res.locals.identity as RequestIdentity | undefined;
  if (!found) throw new Error('The caller was not identified before this route');
  return found;
}

/**
 * The Express server for everything not yet moved into the layers. It handles security, sign-in
 * and tokens for every request, then hands requests for the moved slices to the layered routes.
 */
export function createExpressApp({
  store,
  layeredRoutes,
  signIn,
  snapshots,
  staticDir,
  trustProxy,
  security = new Security(),
  github = new GitHubIntegration(store),
}: AppOptions) {
  // Who is calling is worked out by the middleware below and handed to the layered routes.
  const requests = new WeakMap<object, { caller: Caller; identity: RequestIdentity; secure: boolean }>();
  const known = (req: object) => {
    const found = requests.get(req);
    if (!found) throw new Error('A layered route ran before the caller was identified');
    return found;
  };
  const layered = layeredRoutes({
    caller: (req) => requests.get(req)?.caller ?? ANONYMOUS,
    identity: (req) => known(req).identity,
    secure: (req) => known(req).secure,
  });
  const ownedByLayers = (req: Request) => req.path.toLowerCase().startsWith('/api/') && layered.owns(req.method, req.path.slice(4));

  const app = express();
  app.disable('x-powered-by');
  if (trustProxy !== undefined) app.set('trust proxy', trustProxy);
  app.use(securityHeaders);
  if (security) app.use(security.firewall);
  // Small bodies everywhere; the backup import route parses its own larger body, but only
  // after the caller has been checked as an administrator.
  const smallJson = express.json({ limit: JSON_LIMIT });
  const ownBodyParser = new Set(['/api/backup/import', WEBHOOK_PATH]);
  app.use((req, res, next) => (ownBodyParser.has(req.path) || ownedByLayers(req) ? next() : smallJson(req, res, next)));

  const api = express.Router();

  /** Identify the caller once per request; the sign-in rules live in the layers. */
  const identify = (req: Request, res: Response, next: NextFunction) => {
    if (res.locals.identity) return next();
    signIn.authenticator.identify(req).then((found) => {
      res.locals.identity = found;
      // Read by the rate limits and the abuse checks.
      res.locals.authMember = found.identity.member;
      res.locals.invalidToken = found.identity.invalidToken;
      next();
    }, next);
  };

  /** Restrict a route to administrators while sign-in is on; API tokens never. */
  const admin = (_req: Request, res: Response, next: NextFunction) => {
    const access = adminAccessOf(identityOf(res).identity);
    if (access === 'token') throw new HttpError(403, "API tokens can't be used to administer the project");
    if (access === 'not-admin') throw new HttpError(403, 'Only administrators can do this');
    next();
  };
  const pass = (_req: Request, _res: Response, next: NextFunction) => next();
  const heavy = security ? security.heavy : pass;

  api.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  // Liveness check for load balancers and container health checks; public and data-free.
  api.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  if (security) {
    api.use(security.sameOrigin);
    // Identify the caller first so limits apply per person, and to anonymous callers
    // before sign-in turns them away.
    api.use(identify);
    api.use(security.apiLimits(() => signIn.enabled));
    api.use(['/auth/login', '/auth/password'], security.signIn);
  }
  // GitHub webhooks authenticate with a signature over the body, not a session.
  api.post('/integrations/github/webhook', github.precheck, GitHubIntegration.rawBody, github.webhook);

  // With sign-in on, everything below needs a valid session (or an API token).
  api.use(identify);
  api.use((req, res, next) => {
    const decision = gate(identityOf(res).identity, req.method, req.path);
    if (decision.kind === 'reject') return res.status(decision.status).json(decision.body);
    // History and comments are attributed to who actually made the change.
    if (decision.actAs === null) delete req.headers['x-user'];
    else if (decision.actAs !== 'as-sent') req.headers['x-user'] = encodeURIComponent(decision.actAs);
    next();
  });

  /** Wrap a mutation: run it in a transaction and reply with the resulting delta. */
  const mutate =
    <T>(fn: (tx: Tx, req: Request, res: Response) => T, status = 200) =>
    (req: Request, res: Response) => {
      const { delta, result } = store.transact(userName(store, req), req.header('x-client-id'), (tx) => fn(tx, req, res));
      res.status(status).json({ delta, result });
    };

  /**
   * With sign-in on, or for an API token, only a comment's author or an administrator (never a
   * token) may change it. With sign-in off anyone may, as with everything else.
   */
  const callerOf = (req: Request, res: Response): Caller => {
    const { identity } = identityOf(res);
    return {
      name: userName(store, req),
      memberId: callerId(store, req, res),
      mayModerateComments: mayModerateCommentsOf(identity),
      admin: adminAccessOf(identity),
      origin: req.header('x-client-id'),
    };
  };

  // Sign-in and API tokens, work items, links, the recycle bin, sprints, capacity, team members
  // and project settings.
  api.use((req, res, next) => {
    if (!layered.owns(req.method, req.path)) return next();
    requests.set(req, { caller: callerOf(req, res), identity: identityOf(res), secure: req.secure });
    layered.handle(req, res).then((handled) => {
      if (!handled) next();
    }, next);
  });

  api.get('/bootstrap', (_req, res) => {
    res.json({ db: store.db, serverTime: new Date().toISOString() });
  });

  // Server-sent events: every committed change is pushed to connected browsers.
  api.get('/events', (req, res) => {
    const release = security ? security.openStream(req, res) : () => {};
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`event: hello\ndata: ${JSON.stringify({ version: store.db.version })}\n\n`);
    // Stop streaming once the session times out, the user is signed out, or sign-in is turned on.
    const { identity, sessionToken } = identityOf(res);
    const token = identity.via === 'session' ? sessionToken : undefined;
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      clearInterval(heartbeat);
      unsubscribe();
      release();
      res.end();
    };
    // Checks are asynchronous; chaining them keeps the stream's messages in order.
    let queue = Promise.resolve();
    const send = (message: string) => {
      queue = queue
        .then(() => signIn.authenticator.stillSignedIn(token))
        .then((allowed) => {
          if (stopped) return;
          if (allowed) res.write(message);
          else stop();
        })
        .catch(() => stop());
    };
    const unsubscribe = store.subscribe((delta, origin) => send(`data: ${JSON.stringify({ delta, origin })}\n\n`));
    const heartbeat = setInterval(() => send(': ping\n\n'), 25_000);
    req.on('close', () => {
      stopped = true;
      clearInterval(heartbeat);
      unsubscribe();
      release();
    });
  });

  // ---- Work item development links (GitHub) -----------------------------------
  api.delete(
    '/workitems/:id/devlinks/:linkId',
    mutate((tx, req) => github.removeLink(tx, intParam(req.params.id), String(req.params.linkId))),
  );

  // ---- Integrations (administrators) -----------------------------------------
  api.get('/integrations/github', admin, (_req, res) => {
    res.json(github.adminView());
  });
  api.put('/integrations/github', admin, (req, res) => {
    github.updateSettings(githubSettingsSchema.parse(req.body));
    res.json(github.adminView());
  });
  api.post('/integrations/github/secret', admin, (_req, res) => {
    const secret = github.rotateSecret();
    res.json({ secret, view: github.adminView() });
  });

  // ---- Snapshots & backups ----------------------------------------------------
  const snapshotInput = z.object({ name: z.string().trim().max(200).optional(), description: z.string().max(2000).optional() }).strict();

  api.get('/snapshots', (_req, res) => {
    res.json(snapshots.list());
  });
  api.post('/snapshots', heavy, (req, res) => {
    const input = snapshotInput.parse(req.body ?? {});
    res.status(201).json(snapshots.create(input.name ?? '', input.description ?? '', 'manual', userName(store, req)));
  });
  api.patch('/snapshots/:id', admin, (req, res) => {
    res.json(snapshots.update(String(req.params.id), snapshotInput.parse(req.body)));
  });
  api.delete('/snapshots/:id', admin, (req, res) => {
    snapshots.delete(String(req.params.id));
    res.status(204).end();
  });
  api.post('/snapshots/:id/restore', admin, heavy, (req, res) => {
    const safety = snapshots.restore(String(req.params.id), userName(store, req), req.header('x-client-id'));
    res.json({ safetySnapshot: safety });
  });
  api.get('/snapshots/:id/download', heavy, (req, res) => {
    const file = snapshots.filePath(String(req.params.id));
    res.download(file, `snapshot-${req.params.id}.json`);
  });

  api.get('/backup/export', heavy, (req, res) => {
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
  api.post('/backup/import', admin, heavy, express.json({ limit: IMPORT_LIMIT }), (req, res) => {
    try {
      const safety = snapshots.import(req.body, userName(store, req), req.header('x-client-id'));
      res.json({ safetySnapshot: safety });
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw badRequest(err instanceof Error ? err.message : 'Invalid backup file');
    }
  });
  api.post('/backup/reset', admin, heavy, (req, res) => {
    const { mode } = z.object({ mode: z.enum(['empty', 'demo']) }).parse(req.body);
    const settings = { ...store.db.settings };
    const next = mode === 'demo' ? buildDemoDatabase() : emptyDatabase({ projectName: settings.projectName, teamName: settings.teamName, backup: settings.backup, workingDays: settings.workingDays, areaPaths: settings.areaPaths });
    store.check(next);
    const safety = snapshots.create('Before reset', `Automatic safety snapshot taken before resetting to ${mode === 'demo' ? 'demo data' : 'an empty project'}`, 'pre-reset', userName(store, req));
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
    if (err instanceof MissingRecordError) return res.status(404).json({ error: err.message });
    if (err instanceof RejectedChangeError) return res.status(400).json({ error: err.message });
    if (err instanceof HttpError) {
      const retryAfter = retryAfterOf(err);
      if (retryAfter) res.setHeader('Retry-After', String(retryAfter));
      return res.status(err.status).json({ error: err.message });
    }
    if (err instanceof SyntaxError && 'body' in (err as object)) return res.status(400).json({ error: 'Malformed JSON' });
    if ((err as { type?: string })?.type === 'entity.too.large') return res.status(413).json({ error: 'Request is too large' });
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
