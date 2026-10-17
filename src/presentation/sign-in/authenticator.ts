import type { IncomingMessage } from 'node:http';
import type { Identity } from '#application/sign-in/identity.ts';
import type { IdentifyCaller } from '#application/sign-in/identify-caller.ts';
import { SESSION_COOKIE, readCookie } from './cookies.ts';

export interface RequestIdentity {
  readonly identity: Identity;
  /** The session cookie the request carried, if any. */
  readonly sessionToken: string | undefined;
}

/** Reads a request's session cookie or API token and asks who that is. */
export class Authenticator {
  readonly #identify: Pick<IdentifyCaller, 'execute'>;

  constructor(identify: Pick<IdentifyCaller, 'execute'>) {
    this.#identify = identify;
  }

  async identify(req: IncomingMessage): Promise<RequestIdentity> {
    const header = req.headers.authorization ?? '';
    const apiToken = /^Bearer\s+(\S+)$/i.exec(header)?.[1];
    const sessionToken = readCookie(req, SESSION_COOKIE);
    const identity = await this.#identify.execute({ apiToken, sessionToken, touch: true });
    return { identity, sessionToken };
  }

  /** For long-lived streams: whether the session is still good (always, with sign-in off). */
  async stillSignedIn(sessionToken: string | undefined): Promise<boolean> {
    const identity = await this.#identify.execute({ sessionToken, touch: false });
    return !identity.signInEnabled || identity.member !== null;
  }
}
