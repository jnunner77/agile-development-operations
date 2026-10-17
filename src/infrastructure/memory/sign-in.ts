import { ApiToken, type StoredApiToken } from '#domain/api-tokens/api-token.ts';
import type { ApiTokenRepository } from '#domain/api-tokens/repository.ts';
import { Account, type AccountData } from '#domain/sign-in/account.ts';
import type { AccountRepository, SignInSettingsRepository } from '#domain/sign-in/repository.ts';
import { SignInSettings, type SignInSettingsData } from '#domain/sign-in/settings.ts';

export class MemoryAccountRepository implements AccountRepository {
  readonly #rows = new Map<string, AccountData>();

  async get(memberId: string): Promise<Account> {
    const row = this.#rows.get(memberId);
    return row ? Account.reconstitute({ ...row }) : Account.blank(memberId);
  }

  async all(): Promise<Account[]> {
    return [...this.#rows.values()].map((r) => Account.reconstitute({ ...r }));
  }

  async save(account: Account): Promise<void> {
    this.#rows.set(account.memberId, account.toSnapshot());
  }
}

export class MemorySignInSettingsRepository implements SignInSettingsRepository {
  #row: SignInSettingsData;

  constructor(row: Partial<SignInSettingsData> = {}) {
    this.#row = SignInSettings.reconstitute(row).toSnapshot();
  }

  async get(): Promise<SignInSettings> {
    return SignInSettings.reconstitute({ ...this.#row });
  }

  async save(settings: SignInSettings): Promise<void> {
    this.#row = settings.toSnapshot();
  }
}

export class MemoryApiTokenRepository implements ApiTokenRepository {
  #rows: StoredApiToken[] = [];

  async all(): Promise<ApiToken[]> {
    return this.#rows.map((r) => ApiToken.reconstitute({ ...r }));
  }

  async findById(id: string): Promise<ApiToken | undefined> {
    const row = this.#rows.find((r) => r.id === id);
    return row ? ApiToken.reconstitute({ ...row }) : undefined;
  }

  async findByDigest(digest: string): Promise<ApiToken | undefined> {
    const row = this.#rows.find((r) => r.hash === digest);
    return row ? ApiToken.reconstitute({ ...row }) : undefined;
  }

  async save(token: ApiToken): Promise<void> {
    const row = token.toSnapshot();
    this.#rows = [...this.#rows.filter((r) => r.id !== row.id), row];
  }

  async saveUse(token: ApiToken): Promise<void> {
    await this.save(token);
  }

  async delete(id: string): Promise<void> {
    this.#rows = this.#rows.filter((r) => r.id !== id);
  }

  rows(): StoredApiToken[] {
    return this.#rows.map((r) => ({ ...r }));
  }
}
