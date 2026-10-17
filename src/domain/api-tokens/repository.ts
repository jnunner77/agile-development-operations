import type { ApiToken } from './api-token.ts';

export interface ApiTokenRepository {
  all(): Promise<ApiToken[]>;
  findById(id: string): Promise<ApiToken | undefined>;
  findByDigest(digest: string): Promise<ApiToken | undefined>;
  save(token: ApiToken): Promise<void>;
  /** Note that a token was used. Adapters may write this lazily; it is only shown in lists. */
  saveUse(token: ApiToken): Promise<void>;
  delete(id: string): Promise<void>;
  /**
   * Remove every token that acts as the member, in one change, without reading them: a damaged
   * token must never stop a revocation. Returns the ids removed.
   */
  deleteForMember(memberId: string): Promise<string[]>;
  /** Remove these tokens in one change. */
  deleteMany(ids: readonly string[]): Promise<void>;
}
