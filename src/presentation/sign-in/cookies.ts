import type { IncomingMessage } from 'node:http';

export const SESSION_COOKIE = 'boards_session';

export function readCookie(req: IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return undefined; // not valid percent-encoding: no cookie
      }
    }
  }
  return undefined;
}

/** HttpOnly keeps the token from page scripts; SameSite=Strict blocks cross-site use; Secure over HTTPS. */
export function sessionCookie(token: string, secure: boolean): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
}

export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}
