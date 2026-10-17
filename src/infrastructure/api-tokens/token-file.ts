import crypto from 'node:crypto';
import path from 'node:path';
import { ApiToken, type StoredApiToken } from '#domain/api-tokens/api-token.ts';
import type { ApiTokenRepository } from '#domain/api-tokens/repository.ts';
import { readJsonFile, writeSecretFile } from '../files.ts';

/** lastUsedAt is written to disk at most this often per token; it is only shown in lists. */
const USE_WRITE_INTERVAL_MS = 60_000;

/** Same-length strings compared in constant time, so a digest lookup leaks nothing by timing. */
function sameDigest(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** API tokens in api-tokens.json in the data directory, apart from db.json. Only digests are stored. */
export class FileApiTokenRepository implements ApiTokenRepository {
  readonly #file: string;
  readonly #now: () => number;
  #tokens: StoredApiToken[];
  readonly #lastUseWrite = new Map<string, number>();

  constructor(dataDir: string, now: () => number = Date.now) {
    this.#file = path.join(dataDir, 'api-tokens.json');
    this.#now = now;
    const raw = readJsonFile(this.#file);
    const tokens = typeof raw === 'object' && raw !== null && 'tokens' in raw && Array.isArray(raw.tokens) ? raw.tokens : [];
    // Each is validated by ApiToken.reconstitute when read.
    this.#tokens = tokens as StoredApiToken[];
  }

  async all(): Promise<ApiToken[]> {
    return this.#tokens.map((t) => ApiToken.reconstitute(t));
  }

  async findById(id: string): Promise<ApiToken | undefined> {
    const stored = this.#tokens.find((t) => t.id === id);
    return stored ? ApiToken.reconstitute(stored) : undefined;
  }

  async findByDigest(digest: string): Promise<ApiToken | undefined> {
    const stored = this.#tokens.find((t) => sameDigest(t.hash, digest));
    return stored ? ApiToken.reconstitute(stored) : undefined;
  }

  async save(token: ApiToken): Promise<void> {
    const row = token.toSnapshot();
    const exists = this.#tokens.some((t) => t.id === row.id);
    this.#write(exists ? this.#tokens.map((t) => (t.id === row.id ? row : t)) : [...this.#tokens, row]);
  }

  async saveUse(token: ApiToken): Promise<void> {
    const row = token.toSnapshot();
    const now = this.#now();
    const next = this.#tokens.map((t) => (t.id === row.id ? { ...t, lastUsedAt: row.lastUsedAt } : t));
    if (now - (this.#lastUseWrite.get(row.id) ?? 0) < USE_WRITE_INTERVAL_MS) {
      this.#tokens = next; // kept in memory; written with the next change or use after the interval
      return;
    }
    this.#lastUseWrite.set(row.id, now);
    this.#write(next);
  }

  async delete(id: string): Promise<void> {
    if (!this.#tokens.some((t) => t.id === id)) return;
    this.#lastUseWrite.delete(id);
    this.#write(this.#tokens.filter((t) => t.id !== id));
  }

  #write(next: StoredApiToken[]): void {
    writeSecretFile(this.#file, { tokens: next });
    this.#tokens = next;
  }
}
