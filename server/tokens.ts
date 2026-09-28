import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { ApiTokenInfo, ApiTokenScope } from '../shared/auth';
import type { Member } from '../shared/types';
import { HttpError, badRequest, notFound } from './errors';
import type { Store } from './store';

// API tokens let scripts and assistants use the API without a password. A token acts as
// one team member, is read-only or read & write, always expires, and can be revoked. Only a
// SHA-256 hash is stored (tokens are long random strings, so a slow hash isn't needed), in a
// file of its own that never reaches browsers, snapshots or backups.

const PREFIX = 'boards_';
const DAY_MS = 86_400_000;
export const TOKEN_MAX_DAYS = 365;
const MAX_PER_MEMBER = 20;
/** lastUsedAt is written to disk at most this often per token. */
const TOUCH_INTERVAL_MS = 60_000;

interface StoredToken {
  id: string;
  name: string;
  memberId: string;
  scope: ApiTokenScope;
  /** First characters of the token, shown so people can tell tokens apart. */
  prefix: string;
  hash: string;
  createdAt: string;
  createdBy: string;
  expiresAt: string;
  lastUsedAt: string | null;
}

export const createTokenSchema = z
  .object({
    name: z.string().trim().min(1, 'Give the token a name').max(100),
    memberId: z.string().optional(),
    scope: z.enum(['read', 'write']).default('read'),
    expiresInDays: z.number().int().min(1).max(TOKEN_MAX_DAYS, `Tokens can last at most ${TOKEN_MAX_DAYS} days`).default(90),
  })
  .strict();

const hash = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

export class TokenManager {
  private tokens: StoredToken[] = [];
  private readonly file: string;
  private readonly lastWrite = new Map<string, number>();

  constructor(
    private readonly store: Store,
    private readonly now: () => number = Date.now,
  ) {
    this.file = path.join(store.dataDir, 'api-tokens.json');
    if (fs.existsSync(this.file)) this.tokens = (JSON.parse(fs.readFileSync(this.file, 'utf8')) as { tokens?: StoredToken[] }).tokens ?? [];
  }

  private save() {
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ tokens: this.tokens }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  private view(t: StoredToken): ApiTokenInfo {
    const { hash: _hash, ...info } = t;
    return { ...info, expired: Date.parse(t.expiresAt) <= this.now() };
  }

  list(memberId?: string): ApiTokenInfo[] {
    return this.tokens.filter((t) => !memberId || t.memberId === memberId).map((t) => this.view(t));
  }

  /** Create a token; the secret is returned once and never stored. */
  create(input: z.infer<typeof createTokenSchema>, memberId: string, createdBy: string): { token: string; info: ApiTokenInfo } {
    const member = this.store.db.members.find((m) => m.id === memberId);
    if (!member) throw notFound('Team member');
    if (!member.active) throw badRequest(`${member.name} is inactive`);
    if (this.tokens.filter((t) => t.memberId === memberId).length >= MAX_PER_MEMBER) {
      throw badRequest(`${member.name} already has ${MAX_PER_MEMBER} tokens. Revoke some first.`);
    }
    const token = PREFIX + crypto.randomBytes(32).toString('base64url');
    const now = this.now();
    const stored: StoredToken = {
      id: crypto.randomUUID(),
      name: input.name,
      memberId,
      scope: input.scope,
      prefix: token.slice(0, PREFIX.length + 6),
      hash: hash(token),
      createdAt: new Date(now).toISOString(),
      createdBy,
      expiresAt: new Date(now + input.expiresInDays * DAY_MS).toISOString(),
      lastUsedAt: null,
    };
    this.tokens.push(stored);
    this.save();
    return { token, info: this.view(stored) };
  }

  revoke(id: string) {
    const before = this.tokens.length;
    this.tokens = this.tokens.filter((t) => t.id !== id);
    if (this.tokens.length === before) throw notFound('Token');
    this.save();
  }

  get(id: string): ApiTokenInfo {
    const t = this.tokens.find((x) => x.id === id);
    if (!t) throw notFound('Token');
    return this.view(t);
  }

  /** The member and token for a presented secret, or null if it is unknown, expired or its member is gone. */
  verify(secret: string): { member: Member; token: ApiTokenInfo } | null {
    if (!secret.startsWith(PREFIX) || secret.length > 200) return null;
    const h = hash(secret);
    const t = this.tokens.find((x) => crypto.timingSafeEqual(Buffer.from(x.hash), Buffer.from(h)));
    if (!t) return null;
    const now = this.now();
    if (Date.parse(t.expiresAt) <= now) return null;
    const member = this.store.db.members.find((m) => m.id === t.memberId && m.active);
    if (!member) return null;
    t.lastUsedAt = new Date(now).toISOString();
    if (now - (this.lastWrite.get(t.id) ?? 0) >= TOUCH_INTERVAL_MS) {
      this.lastWrite.set(t.id, now);
      this.save();
    }
    return { member, token: this.view(t) };
  }
}

/** Thrown when an API token is used for something tokens may not do. */
export const tokenForbidden = (what: string) => new HttpError(403, `API tokens can't be used to ${what}`);
