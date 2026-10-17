import path from 'node:path';
import type { AccountRepository, SignInSettingsRepository } from '#domain/sign-in/repository.ts';
import { Account, type AccountData } from '#domain/sign-in/account.ts';
import { DEFAULT_SIGN_IN_SETTINGS, SignInSettings, type SignInSettingsData } from '#domain/sign-in/settings.ts';
import { readJsonFile, writeSecretFile } from '../files.ts';

type StoredAccount = Omit<AccountData, 'memberId'>;

/** auth.json: sign-in settings and accounts, keyed by member id. */
interface AuthFileData {
  settings: SignInSettingsData;
  accounts: Record<string, StoredAccount>;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Sign-in settings and accounts, in auth.json in the data directory. It holds password hashes, so
 * it is kept apart from db.json and never reaches browsers, snapshots or exports. Loaded once and
 * kept in memory; every change is written straight through.
 */
export class AuthFile {
  readonly #file: string;
  #data: AuthFileData;

  constructor(dataDir: string) {
    this.#file = path.join(dataDir, 'auth.json');
    const raw = readJsonFile(this.#file);
    const settings = isRecord(raw) && isRecord(raw['settings']) ? raw['settings'] : {};
    const accounts = isRecord(raw) && isRecord(raw['accounts']) ? raw['accounts'] : {};
    // Shapes are checked as accounts are read; the file is only ever written by this class.
    this.#data = { settings: { ...DEFAULT_SIGN_IN_SETTINGS, ...(settings as Partial<SignInSettingsData>) }, accounts: accounts as Record<string, StoredAccount> };
  }

  /** The stored settings, synchronously (for guards and per-request checks). */
  get settings(): SignInSettingsData {
    return { ...this.#data.settings };
  }

  account(memberId: string): Account {
    const stored = this.#data.accounts[memberId];
    return stored ? Account.reconstitute({ ...stored, memberId }) : Account.blank(memberId);
  }

  accounts(): Account[] {
    return Object.entries(this.#data.accounts).map(([memberId, stored]) => Account.reconstitute({ ...stored, memberId }));
  }

  saveAccount(account: Account): void {
    const { memberId, ...stored } = account.toSnapshot();
    this.#write({ ...this.#data, accounts: { ...this.#data.accounts, [memberId]: stored } });
  }

  saveSettings(settings: SignInSettingsData): void {
    this.#write({ ...this.#data, settings: { ...settings } });
  }

  /** On disk first, so a failed write changes nothing. */
  #write(next: AuthFileData): void {
    writeSecretFile(this.#file, next);
    this.#data = next;
  }
}

export class FileAccountRepository implements AccountRepository {
  readonly #file: AuthFile;

  constructor(file: AuthFile) {
    this.#file = file;
  }

  async get(memberId: string): Promise<Account> {
    return this.#file.account(memberId);
  }

  async all(): Promise<Account[]> {
    return this.#file.accounts();
  }

  async save(account: Account): Promise<void> {
    this.#file.saveAccount(account);
  }
}

export class FileSignInSettingsRepository implements SignInSettingsRepository {
  readonly #file: AuthFile;

  constructor(file: AuthFile) {
    this.#file = file;
  }

  async get(): Promise<SignInSettings> {
    return SignInSettings.reconstitute(this.#file.settings);
  }

  async save(settings: SignInSettings): Promise<void> {
    this.#file.saveSettings(settings.toSnapshot());
  }
}
