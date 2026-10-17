import type { DomainEvent } from '#domain/events.ts';
import type { Member } from '#domain/types.ts';
import type { Result } from '#shared/result.ts';
import type { Delta } from './contracts/database.ts';

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  next(): string;
}

export interface EventPublisher {
  publish(events: readonly DomainEvent[]): Promise<void>;
}

/** Who a change is attributed to, and which browser tab sent it (so it can skip its own echo). */
export interface ChangeMeta {
  readonly actor: string;
  readonly origin: string | undefined;
}

/** A committed change: the use case's result and the change set sent to every browser. */
export interface Committed<T> {
  readonly result: T;
  readonly delta: Delta;
}

export interface UnitOfWork {
  /**
   * Run `work` as one atomic change. It is committed when the work returns ok, and discarded,
   * leaving nothing changed, when it returns an error or throws.
   */
  run<T, E>(meta: ChangeMeta, work: () => Promise<Result<T, E>>): Promise<Result<Committed<T>, E>>;
}

/** One-way password hashing, deliberately slow. */
export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(password: string, stored: string): Promise<boolean>;
  /** Take as long as `verify` does, for a username that doesn't exist, so timing gives nothing away. */
  verifyNothing(password: string): Promise<void>;
}

/** Unguessable secrets, and the digest kept in their place. */
export interface Secrets {
  newSessionToken(): string;
  /** A new API token secret, starting with the API token prefix. */
  newApiToken(): string;
  digest(secret: string): string;
}

/**
 * The team as last saved, for reading outside a unit of work (sign-in runs on every request and
 * changes nothing in the project).
 */
export interface TeamDirectory {
  all(): Promise<Member[]>;
  findById(id: string): Promise<Member | undefined>;
}

/**
 * Runs read-change-write steps one at a time, so two of them can't each read the same account or
 * token list and the second write undo the first.
 */
export interface SerialWrites {
  run<T>(work: () => Promise<T>): Promise<T>;
}
