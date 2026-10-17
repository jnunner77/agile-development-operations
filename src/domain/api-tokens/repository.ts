import type { ApiToken } from './api-token.ts';

export interface ApiTokenRepository {
  all(): Promise<ApiToken[]>;
  findById(id: string): Promise<ApiToken | undefined>;
  findByDigest(digest: string): Promise<ApiToken | undefined>;
  save(token: ApiToken): Promise<void>;
  /** Note that a token was used. Adapters may write this lazily; it is only shown in lists. */
  saveUse(token: ApiToken): Promise<void>;
  delete(id: string): Promise<void>;
}
