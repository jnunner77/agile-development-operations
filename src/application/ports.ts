import type { DomainEvent } from '#domain/events.ts';
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
 * What the work item use cases need to know about the rest of the project. Sprints, members and
 * settings move into their own aggregates in a later slice; until then this port answers for them.
 */
export interface ProjectDirectory {
  memberExists(id: string): Promise<boolean>;
  sprintExists(id: string): Promise<boolean>;
  /** Area path for new items that have no parent to inherit one from. */
  defaultAreaPath(): Promise<string>;
}
