import type { FailedAttemptsRepository, SessionRepository } from '#domain/sign-in/repository.ts';
import type { FailedAttempts } from '#domain/sign-in/lockout.ts';
import type { Session } from '#domain/sign-in/session.ts';

/** Sessions live in memory only: a restart signs everyone out, and no session secret is ever written. */
export class MemorySessionRepository implements SessionRepository {
  readonly #sessions = new Map<string, Session>();

  async find(token: string): Promise<Session | undefined> {
    return this.#sessions.get(token);
  }

  async forMember(memberId: string): Promise<Session[]> {
    return [...this.#sessions.values()].filter((s) => s.memberId === memberId);
  }

  async all(): Promise<Session[]> {
    return [...this.#sessions.values()];
  }

  async save(session: Session): Promise<void> {
    this.#sessions.set(session.token, { ...session });
  }

  async delete(token: string): Promise<void> {
    this.#sessions.delete(token);
  }
}

/** Failed sign-ins, in memory: a restart forgets them. */
export class MemoryFailedAttemptsRepository implements FailedAttemptsRepository {
  readonly #records = new Map<string, FailedAttempts>();

  /** How many usernames have failure records (for tests and diagnostics). */
  get size(): number {
    return this.#records.size;
  }

  async find(key: string): Promise<FailedAttempts | undefined> {
    return this.#records.get(key);
  }

  async all(): Promise<[string, FailedAttempts][]> {
    return [...this.#records];
  }

  async save(key: string, record: FailedAttempts): Promise<void> {
    this.#records.set(key, { ...record });
  }

  async delete(key: string): Promise<void> {
    this.#records.delete(key);
  }
}
