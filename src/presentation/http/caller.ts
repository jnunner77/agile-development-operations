import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Caller } from '#application/caller.ts';

/**
 * Works out who is calling. Sign-in, API tokens and the X-User header belong to the delivery
 * mechanism, so the composition root supplies this.
 */
export type CallerResolver = (req: IncomingMessage, res: ServerResponse) => Caller;
