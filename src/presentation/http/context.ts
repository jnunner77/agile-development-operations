import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RequestIdentity } from '../sign-in/authenticator.ts';
import type { CallerResolver } from './caller.ts';

/** What the delivery pipeline knows about a request before a route runs. */
export interface RequestContext {
  readonly caller: CallerResolver;
  readonly identity: (req: IncomingMessage, res: ServerResponse) => RequestIdentity;
  /** Whether the request reached the server over HTTPS (behind a proxy, as the proxy says). */
  readonly secure: (req: IncomingMessage, res: ServerResponse) => boolean;
  /**
   * Count an expensive operation (snapshots, backups) against the caller's limit. False when they
   * are over it, and the 429 answer has already been sent.
   */
  readonly heavyOperation: (req: IncomingMessage, res: ServerResponse) => boolean;
}
