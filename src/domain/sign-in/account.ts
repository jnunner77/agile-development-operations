const DAY_MS = 86_400_000;

/** How an account is stored: a password hash (never the password), never sent to browsers. */
export interface AccountData {
  readonly memberId: string;
  readonly isAdmin: boolean;
  readonly passwordHash: string | null;
  readonly passwordSetAt: string | null;
  /** Set by an administrator: the password is temporary and must be replaced at the next sign-in. */
  readonly mustChange: boolean;
}

export type AccountEvent =
  | { readonly type: 'AdministratorChanged'; readonly memberId: string; readonly isAdmin: boolean; readonly occurredAt: Date }
  | { readonly type: 'PasswordSet'; readonly memberId: string; readonly temporary: boolean; readonly occurredAt: Date }
  | { readonly type: 'PasswordCleared'; readonly memberId: string; readonly occurredAt: Date };

/** A team member's sign-in account. Every member has one, blank until set up. */
export class Account {
  #props: AccountData;
  #events: AccountEvent[] = [];

  private constructor(props: AccountData) {
    this.#props = props;
  }

  static blank(memberId: string): Account {
    return new Account({ memberId, isAdmin: false, passwordHash: null, passwordSetAt: null, mustChange: false });
  }

  static reconstitute(data: AccountData): Account {
    if (!data.memberId) throw new Error('Stored account has no member');
    return new Account({ ...data });
  }

  get memberId(): string {
    return this.#props.memberId;
  }
  get isAdmin(): boolean {
    return this.#props.isAdmin;
  }
  get hasPassword(): boolean {
    return !!this.#props.passwordHash;
  }
  get passwordHash(): string | null {
    return this.#props.passwordHash;
  }
  get passwordSetAt(): string | null {
    return this.#props.passwordSetAt;
  }
  get mustChange(): boolean {
    return this.#props.mustChange;
  }

  /** When the password expires, or null if it never does. */
  expiresAt(expiryDays: number): Date | null {
    if (!expiryDays || !this.#props.passwordSetAt) return null;
    return new Date(Date.parse(this.#props.passwordSetAt) + expiryDays * DAY_MS);
  }

  isExpired(now: Date, expiryDays: number): boolean {
    const at = this.expiresAt(expiryDays);
    return at !== null && now.getTime() >= at.getTime();
  }

  /** Signing in needs a password that isn't temporary and hasn't expired. */
  canHoldSession(now: Date, expiryDays: number): boolean {
    return this.hasPassword && !this.#props.mustChange && !this.isExpired(now, expiryDays);
  }

  setAdmin(isAdmin: boolean, now: Date): void {
    this.#props = { ...this.#props, isAdmin };
    this.#events.push({ type: 'AdministratorChanged', memberId: this.#props.memberId, isAdmin, occurredAt: now });
  }

  /** Store a new password hash. A temporary one must be changed at the next sign-in. */
  setPassword(hash: string, now: Date, temporary: boolean): void {
    this.#props = { ...this.#props, passwordHash: hash, passwordSetAt: now.toISOString(), mustChange: temporary };
    this.#events.push({ type: 'PasswordSet', memberId: this.#props.memberId, temporary, occurredAt: now });
  }

  /** No password: nobody can sign in as this member until an administrator sets one. */
  clearPassword(now: Date): void {
    this.#props = { ...this.#props, passwordHash: null, passwordSetAt: null, mustChange: false };
    this.#events.push({ type: 'PasswordCleared', memberId: this.#props.memberId, occurredAt: now });
  }

  pullEvents(): readonly AccountEvent[] {
    const events = this.#events;
    this.#events = [];
    return events;
  }

  toSnapshot(): AccountData {
    return { ...this.#props };
  }
}
