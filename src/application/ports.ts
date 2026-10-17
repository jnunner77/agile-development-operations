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

/**
 * With sign-in on, at least one administrator who can actually sign in must remain. Who is an
 * administrator is part of sign-in, which hasn't moved into the layers yet; this port asks it.
 */
export interface AdminSafeguard {
  /** Whether a team made of `members` would still have an administrator who can sign in. */
  keepsUsableAdmin(members: readonly Member[]): Promise<boolean>;
}
