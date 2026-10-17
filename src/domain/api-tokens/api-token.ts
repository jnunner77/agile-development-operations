import { err, ok, type Result } from '#shared/result.ts';

// API tokens let scripts and assistants use the API without a password. A token acts as one team
// member, is read-only or read & write, always expires, and can be revoked. Only a digest of the
// secret is kept, never the secret itself.

export const API_TOKEN_PREFIX = 'boards_';
export const TOKEN_MAX_DAYS = 365;
export const DEFAULT_TOKEN_DAYS = 90;
export const MAX_ACTIVE_TOKENS_PER_MEMBER = 20;
export const MAX_TOKEN_NAME_LENGTH = 100;
/** Expired tokens stay listed (as expired) for this long, then are forgotten. */
export const KEEP_EXPIRED_MS = 30 * 86_400_000;
const MAX_SECRET_LENGTH = 200;
const DAY_MS = 86_400_000;

export const API_TOKEN_SCOPES = ['read', 'write'] as const;
export type ApiTokenScope = (typeof API_TOKEN_SCOPES)[number];

/** An API token as people see it in settings: everything but the digest. */
export interface ApiTokenInfo {
  id: string;
  name: string;
  memberId: string;
  scope: ApiTokenScope;
  /** Start of the token, so people can tell tokens apart. */
  prefix: string;
  createdAt: string;
  createdBy: string;
  expiresAt: string;
  lastUsedAt: string | null;
  expired: boolean;
}

/** How a token is stored. `hash` is the digest of the secret. */
export interface StoredApiToken extends Omit<ApiTokenInfo, 'expired'> {
  hash: string;
}

export type ApiTokenError =
  | { readonly code: 'TOKEN_NAME_REQUIRED' }
  | { readonly code: 'TEXT_TOO_LONG'; readonly field: 'name'; readonly max: number }
  | { readonly code: 'UNKNOWN_TOKEN_SCOPE'; readonly scope: string }
  | { readonly code: 'NOT_AN_INTEGER'; readonly field: 'expiresInDays' }
  | { readonly code: 'NUMBER_OUT_OF_RANGE'; readonly field: 'expiresInDays'; readonly min: number; readonly max: number }
  | { readonly code: 'TOKEN_NOT_FOUND'; readonly id: string }
  | { readonly code: 'TOKEN_MEMBER_REQUIRED' }
  | { readonly code: 'TOKEN_MEMBER_INACTIVE'; readonly name: string }
  | { readonly code: 'TOKEN_LIMIT_REACHED'; readonly name: string; readonly max: number }
  | { readonly code: 'TOKEN_FOR_SOMEONE_ELSE'; readonly action: 'create' | 'revoke' };

export type ApiTokenEvent =
  | { readonly type: 'ApiTokenCreated'; readonly tokenId: string; readonly memberId: string; readonly scope: ApiTokenScope; readonly occurredAt: Date }
  | { readonly type: 'ApiTokenRevoked'; readonly tokenId: string; readonly memberId: string; readonly occurredAt: Date };

/** Only strings that could be one of our tokens are looked up. */
export const looksLikeApiToken = (secret: string): boolean => secret.startsWith(API_TOKEN_PREFIX) && secret.length <= MAX_SECRET_LENGTH;

/** The start of a secret shown in lists, long enough to tell tokens apart and useless on its own. */
export const displayPrefix = (secret: string): string => secret.slice(0, API_TOKEN_PREFIX.length + 6);

function isScope(value: string): value is ApiTokenScope {
  return (API_TOKEN_SCOPES as readonly string[]).includes(value);
}

/** What someone asked for when creating a token, checked. */
export class ApiTokenDraft {
  readonly name: string;
  readonly scope: ApiTokenScope;
  readonly expiresInDays: number;

  private constructor(name: string, scope: ApiTokenScope, expiresInDays: number) {
    this.name = name;
    this.scope = scope;
    this.expiresInDays = expiresInDays;
    Object.freeze(this);
  }

  static of(input: { readonly name: string; readonly scope?: string | undefined; readonly expiresInDays?: number | undefined }): Result<ApiTokenDraft, ApiTokenError> {
    const name = input.name.trim();
    if (!name) return err({ code: 'TOKEN_NAME_REQUIRED' });
    if (name.length > MAX_TOKEN_NAME_LENGTH) return err({ code: 'TEXT_TOO_LONG', field: 'name', max: MAX_TOKEN_NAME_LENGTH });
    const scope = input.scope ?? 'read';
    if (!isScope(scope)) return err({ code: 'UNKNOWN_TOKEN_SCOPE', scope });
    const days = input.expiresInDays ?? DEFAULT_TOKEN_DAYS;
    if (!Number.isInteger(days)) return err({ code: 'NOT_AN_INTEGER', field: 'expiresInDays' });
    if (days < 1 || days > TOKEN_MAX_DAYS) return err({ code: 'NUMBER_OUT_OF_RANGE', field: 'expiresInDays', min: 1, max: TOKEN_MAX_DAYS });
    return ok(new ApiTokenDraft(name, scope, days));
  }
}

export class ApiToken {
  #props: StoredApiToken;
  #events: ApiTokenEvent[] = [];

  private constructor(props: StoredApiToken) {
    this.#props = props;
  }

  static create(
    draft: ApiTokenDraft,
    input: { readonly id: string; readonly memberId: string; readonly secret: string; readonly digest: string; readonly createdBy: string; readonly now: Date },
  ): ApiToken {
    const at = input.now.getTime();
    const token = new ApiToken({
      id: input.id,
      name: draft.name,
      memberId: input.memberId,
      scope: draft.scope,
      prefix: displayPrefix(input.secret),
      hash: input.digest,
      createdAt: input.now.toISOString(),
      createdBy: input.createdBy,
      expiresAt: new Date(at + draft.expiresInDays * DAY_MS).toISOString(),
      lastUsedAt: null,
    });
    token.#events.push({ type: 'ApiTokenCreated', tokenId: input.id, memberId: input.memberId, scope: draft.scope, occurredAt: input.now });
    return token;
  }

  static reconstitute(stored: StoredApiToken): ApiToken {
    if (!stored.id || !stored.hash || !isScope(stored.scope)) throw new Error(`Stored API token ${stored.id} is invalid`);
    return new ApiToken({ ...stored });
  }

  get id(): string {
    return this.#props.id;
  }
  get memberId(): string {
    return this.#props.memberId;
  }
  get scope(): ApiTokenScope {
    return this.#props.scope;
  }
  get digest(): string {
    return this.#props.hash;
  }

  isExpired(now: Date): boolean {
    return Date.parse(this.#props.expiresAt) <= now.getTime();
  }

  /** Expired long enough ago that it is no longer listed. */
  isStale(now: Date): boolean {
    return Date.parse(this.#props.expiresAt) <= now.getTime() - KEEP_EXPIRED_MS;
  }

  recordUse(now: Date): void {
    this.#props = { ...this.#props, lastUsedAt: now.toISOString() };
  }

  revoke(now: Date): void {
    this.#events.push({ type: 'ApiTokenRevoked', tokenId: this.#props.id, memberId: this.#props.memberId, occurredAt: now });
  }

  pullEvents(): readonly ApiTokenEvent[] {
    const events = this.#events;
    this.#events = [];
    return events;
  }

  toInfo(now: Date): ApiTokenInfo {
    const { hash: _digest, ...info } = this.#props;
    return { ...info, expired: this.isExpired(now) };
  }

  toSnapshot(): StoredApiToken {
    return { ...this.#props };
  }
}

/** A member may have only so many tokens that still work. */
export function checkTokenLimit(tokens: readonly ApiToken[], member: { readonly id: string; readonly name: string }, now: Date): Result<void, ApiTokenError> {
  const active = tokens.filter((t) => t.memberId === member.id && !t.isExpired(now)).length;
  return active >= MAX_ACTIVE_TOKENS_PER_MEMBER ? err({ code: 'TOKEN_LIMIT_REACHED', name: member.name, max: MAX_ACTIVE_TOKENS_PER_MEMBER }) : ok(undefined);
}
