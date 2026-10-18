import type { IncomingMessage, ServerResponse } from 'node:http';
import { callerFor } from '#application/caller.ts';
import type { Caller } from '#application/caller.ts';
import type { LoadProject } from '#application/project/load-project.ts';
import type { WatchChanges } from '#application/project/watch-changes.ts';
import type { TeamDirectory } from '#application/ports.ts';
import type { Authenticator, RequestIdentity } from '../../sign-in/authenticator.ts';
import { gate } from '../../sign-in/gate.ts';
import type { RequestContext } from '../context.ts';
import type { HttpFailure } from '../errors.ts';
import { sendJson } from '../respond.ts';
import type { Router } from '../router.ts';
import { clientAddress, trustFunction, type TrustProxy } from './client-address.ts';
import { setSecurityHeaders } from './security-headers.ts';
import type { Refusal, Security } from './security.ts';
import { staticFiles } from './static-files.ts';

export interface PipelineOptions {
  /** The API routes (relative to /api), given what the pipeline knows about each request. */
  readonly routes: (context: RequestContext) => Pick<Router, 'handle' | 'owns'>;
  readonly authenticator: Pick<Authenticator, 'identify' | 'stillSignedIn'>;
  /** Whether sign-in is on now, for the per-request rate limits. */
  readonly signInEnabled: () => boolean;
  readonly team: Pick<TeamDirectory, 'all'>;
  readonly loadProject: Pick<LoadProject, 'execute'>;
  readonly watchChanges: Pick<WatchChanges, 'execute'>;
  /** Rate limits and abuse protection, or false to turn them off (tests). */
  readonly security: Security | false;
  /** Set behind a reverse proxy, so the app sees clients' addresses and the HTTPS scheme. */
  readonly trustProxy?: TrustProxy;
  /** The built client to serve, if any. */
  readonly staticDir?: string | undefined;
  /** How to answer errors adapters throw that mean something (such as a change the store refused). */
  readonly describeError?: (error: unknown) => HttpFailure | undefined;
}

/** What the pipeline worked out about a request before an API route runs. */
interface Known {
  readonly ip: string;
  readonly secure: boolean;
  identity: RequestIdentity | undefined;
  caller: Caller | undefined;
}

const ANONYMOUS: Caller = { name: 'Anonymous', memberId: null, mayModerateComments: false, admin: 'not-admin', origin: undefined };
const SIGN_IN_ROUTE = /^\/auth\/(login|password)(\/|$)/i;
const HEALTH = /^\/health\/?$/i;
const BOOTSTRAP = /^\/bootstrap\/?$/i;
const EVENTS = /^\/events\/?$/i;

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function refuse(res: ServerResponse, refusal: Refusal): void {
  if (refusal.retryAfter !== undefined) res.setHeader('Retry-After', String(refusal.retryAfter));
  if (refusal.close) res.setHeader('Connection', 'close');
  sendJson(res, refusal.status, { error: refusal.message });
}

/** Who the browser says it acts as (X-User, percent-encoded), or null if missing or unreadable. */
function claimedUser(req: IncomingMessage): string | null {
  const raw = header(req, 'x-user');
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/**
 * Every request, in order: security headers; bans and the per-IP limit; then for the API no-store,
 * the health check, the cross-site check, identifying the caller, per-user and sign-in limits, the
 * sign-in gate, and the routes, bootstrap or the live update stream. Anything else is the client.
 */
export function requestPipeline(options: PipelineOptions): (req: IncomingMessage, res: ServerResponse) => void {
  const { security, authenticator } = options;
  const trust = trustFunction(options.trustProxy);
  const known = new WeakMap<IncomingMessage, Known>();
  const knownOf = (req: IncomingMessage): Known & { identity: RequestIdentity } => {
    const found = known.get(req);
    const identity = found?.identity;
    if (!found || !identity) throw new Error('An API route ran before the caller was identified');
    return { ...found, identity };
  };
  const memberOf = (state: Known) => state.identity?.identity.member ?? null;

  const routes = options.routes({
    caller: (req) => known.get(req)?.caller ?? ANONYMOUS,
    identity: (req) => knownOf(req).identity,
    secure: (req) => knownOf(req).secure,
    heavyOperation: (req, res) => {
      if (!security) return true;
      const state = knownOf(req);
      const refusal = security.heavy(state.ip, memberOf(state));
      if (refusal) refuse(res, refusal);
      return !refusal;
    },
  });
  const client = options.staticDir ? staticFiles(options.staticDir) : undefined;

  async function liveUpdates(req: IncomingMessage, res: ServerResponse, state: Known, identity: RequestIdentity): Promise<void> {
    let release = () => {};
    if (security) {
      const stream = security.openStream(state.ip, memberOf(state));
      if ('status' in stream) return refuse(res, stream);
      release = stream.release;
    }
    // Stop streaming once the session times out, the user is signed out, or sign-in is turned on.
    const token = identity.identity.via === 'session' ? identity.sessionToken : undefined;
    let stopped = false;
    let queue = Promise.resolve();
    const send = (message: string) => {
      // Checks are asynchronous; chaining them keeps the stream's messages in order.
      queue = queue
        .then(() => authenticator.stillSignedIn(token))
        .then((allowed) => {
          if (stopped) return;
          if (allowed) res.write(message);
          else stop();
        })
        .catch(() => stop());
    };
    const watching = options.watchChanges.execute((delta, origin) => send(`data: ${JSON.stringify({ delta, origin })}\n\n`));
    const heartbeat = setInterval(() => send(': ping\n\n'), 25_000);
    const end = () => {
      stopped = true;
      clearInterval(heartbeat);
      watching.stop();
      release();
    };
    function stop() {
      if (stopped) return;
      end();
      res.end();
    }
    req.on('close', end);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`event: hello\ndata: ${JSON.stringify({ version: watching.version })}\n\n`);
  }

  async function api(req: IncomingMessage, res: ServerResponse, state: Known, rest: string): Promise<void> {
    res.setHeader('Cache-Control', 'no-store');
    const method = req.method ?? 'GET';
    const path = rest.split('?')[0] || '/';
    // Liveness check for load balancers and container health checks; public and data-free.
    if ((method === 'GET' || method === 'HEAD') && HEALTH.test(path)) return sendJson(res, 200, { status: 'ok' });

    if (security) {
      const crossSite = security.sameOrigin(method, { origin: header(req, 'origin'), host: header(req, 'host'), fetchSite: header(req, 'sec-fetch-site') });
      if (crossSite) return refuse(res, crossSite);
    }
    // Identify the caller first, so limits apply per person, and to anonymous callers before
    // sign-in turns them away.
    const identity = await authenticator.identify(req);
    state.identity = identity;
    if (security) {
      const limited =
        security.apiLimit(state.ip, method, identity.identity.member, options.signInEnabled()) ??
        (method === 'POST' && SIGN_IN_ROUTE.test(path) ? security.signInAttempt(state.ip, res) : null);
      if (limited) return refuse(res, limited);
    }

    // With sign-in on, everything else needs a valid session (or an API token).
    const decision = gate(identity.identity, method, path);
    if (decision.kind === 'reject') return sendJson(res, decision.status, decision.body);
    // History and comments are attributed to who actually made the change.
    const actingAs = decision.actAs === 'as-sent' ? claimedUser(req) : decision.actAs;
    state.caller = callerFor({ identity: identity.identity, actingAs, team: await options.team.all(), origin: header(req, 'x-client-id') });

    if (routes.owns(method, path)) {
      req.url = rest;
      if (await routes.handle(req, res)) return;
    }
    if (method === 'GET' && BOOTSTRAP.test(path)) return sendJson(res, 200, await options.loadProject.execute());
    if (method === 'GET' && EVENTS.test(path)) return liveUpdates(req, res, state, identity);
    sendJson(res, 404, { error: 'Not found' });
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    setSecurityHeaders(res);
    const url = req.url ?? '/';
    const path = url.split('?')[0] || '/';
    const { ip, secure } = clientAddress(req, trust);
    const state: Known = { ip, secure, identity: undefined, caller: undefined };
    known.set(req, state);
    if (security) {
      const refusal = security.admit(ip, path);
      if (refusal) return refuse(res, refusal);
      security.watch(res, ip, path, () => state.identity?.identity.invalidToken ?? false);
    }
    const lower = path.toLowerCase();
    if (lower === '/api' || lower.startsWith('/api/')) return api(req, res, state, url.slice(4) || '/');
    if (client && (await client(req, res, path))) return;
    sendJson(res, 404, { error: 'Not found' });
  }

  return (req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const failure = options.describeError?.(error);
      if (failure) return sendJson(res, failure.status, { error: failure.message });
      console.error(error);
      sendJson(res, 500, { error: 'Internal server error' });
    });
  };
}
