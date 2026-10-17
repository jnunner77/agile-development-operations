import express, { type NextFunction, type Request, type Response } from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { ZodError } from 'zod';
import { HttpError } from './errors.ts';
import { adminAccessOf, mayModerateCommentsOf } from '#application/access.ts';
import type { Caller } from '#application/caller.ts';
import { MissingRecordError, RejectedChangeError, type Store } from '#infrastructure/json-store/store.ts';
import type { RequestContext } from '#presentation/http/context.ts';
import type { Router } from '#presentation/http/router.ts';
import type { Authenticator, RequestIdentity } from '#presentation/sign-in/authenticator.ts';
import { gate } from '#presentation/sign-in/gate.ts';
import { Security, retryAfterOf, securityHeaders } from './security.ts';

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
  staticDir?: string;
  /**
   * Express "trust proxy" setting. Set it when running behind a reverse proxy (e.g. Caddy)
   * so the app sees the original HTTPS scheme and marks sign-in cookies as Secure.
   */
  trustProxy?: boolean | number | string | undefined;
  /** Rate limits and abuse protection; pass false to turn them off (tests). */
  security?: Security | false;
}

/** Largest JSON body accepted by the Express routes. */
const JSON_LIMIT = '2mb';

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
function callerId(store: Store, req: Request, identity: RequestIdentity): string | null {
  const member = identity.identity.member;
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

const ANONYMOUS: Caller = { name: 'Anonymous', memberId: null, mayModerateComments: false, admin: 'not-admin', origin: undefined };


/**
 * The Express server for everything not yet moved into the layers. It handles security, sign-in
 * and tokens for every request, then hands requests for the moved slices to the layered routes.
 */
export function createExpressApp({
  store,
  layeredRoutes,
  signIn,
  staticDir,
  trustProxy,
  security = new Security(),
}: AppOptions) {
  // Who is calling is worked out by the middleware below and handed to the layered routes.
  const requests = new WeakMap<object, { caller: Caller; identity: RequestIdentity; secure: boolean; heavy: () => boolean }>();
  const known = (req: object) => {
    const found = requests.get(req);
    if (!found) throw new Error('A layered route ran before the caller was identified');
    return found;
  };
  const layered = layeredRoutes({
    caller: (req) => requests.get(req)?.caller ?? ANONYMOUS,
    identity: (req) => known(req).identity,
    secure: (req) => known(req).secure,
    heavyOperation: (req) => known(req).heavy(),
  });
  const ownedByLayers = (req: Request) => req.path.toLowerCase().startsWith('/api/') && layered.owns(req.method, req.path.slice(4));

  const app = express();
  app.disable('x-powered-by');
  if (trustProxy !== undefined) app.set('trust proxy', trustProxy);
  app.use(securityHeaders);
  if (security) app.use(security.firewall);
  // Small bodies for the Express routes; the layered routes read their own (the backup import, a
  // larger one, only once the caller is known to be an administrator).
  const smallJson = express.json({ limit: JSON_LIMIT });
  app.use((req, res, next) => (ownedByLayers(req) ? next() : smallJson(req, res, next)));

  const api = express.Router();

  /** Who each request comes from, worked out once by `identify`. */
  const identities = new WeakMap<Request, RequestIdentity>();
  const identityOf = (req: Request): RequestIdentity => {
    const found = identities.get(req);
    if (!found) throw new Error('The caller was not identified before this route');
    return found;
  };

  /** Identify the caller once per request; the sign-in rules live in the layers. */
  const identify = (req: Request, res: Response, next: NextFunction) => {
    if (identities.has(req)) return next();
    signIn.authenticator.identify(req).then((found) => {
      identities.set(req, found);
      // Read by the rate limits and the abuse checks.
      res.locals.authMember = found.identity.member;
      res.locals.invalidToken = found.identity.invalidToken;
      next();
    }, next);
  };

  /** Count a snapshot or backup operation against the caller's limit; answer 429 when over it. */
  const heavyOperation = (req: Request, res: Response): boolean => {
    if (!security) return true;
    try {
      security.heavy(req, res, () => undefined);
      return true;
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      const retryAfter = retryAfterOf(err);
      if (retryAfter) res.setHeader('Retry-After', String(retryAfter));
      res.status(err.status).json({ error: err.message });
      return false;
    }
  };

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
  // With sign-in on, everything below needs a valid session (or an API token).
  api.use(identify);
  api.use((req, res, next) => {
    const decision = gate(identityOf(req).identity, req.method, req.path);
    if (decision.kind === 'reject') return res.status(decision.status).json(decision.body);
    // History and comments are attributed to who actually made the change.
    if (decision.actAs === null) delete req.headers['x-user'];
    else if (decision.actAs !== 'as-sent') req.headers['x-user'] = encodeURIComponent(decision.actAs);
    next();
  });

  /**
   * With sign-in on, or for an API token, only a comment's author or an administrator (never a
   * token) may change it. With sign-in off anyone may, as with everything else.
   */
  function callerOf(req: Request): Caller {
    const found = identityOf(req);
    const { identity } = found;
    return {
      name: userName(store, req),
      memberId: callerId(store, req, found),
      mayModerateComments: mayModerateCommentsOf(identity),
      admin: adminAccessOf(identity),
      origin: req.header('x-client-id'),
    };
  }

  // Sign-in and API tokens, work items, links, the recycle bin, sprints, capacity, team members,
  // project settings and the GitHub integration.
  api.use((req, res, next) => {
    if (!layered.owns(req.method, req.path)) return next();
    requests.set(req, { caller: callerOf(req), identity: identityOf(req), secure: req.secure, heavy: () => heavyOperation(req, res) });
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
    const { identity, sessionToken } = identityOf(req);
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
