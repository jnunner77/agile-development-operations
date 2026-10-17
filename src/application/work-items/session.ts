import type { DomainEvent } from '#domain/events.ts';
import type { ChangeContext } from '#domain/work-items/work-item.ts';
import type { Result } from '#shared/result.ts';
import type { Caller } from '../caller.ts';
import type { Committed } from '../ports.ts';
import type { WorkItemDeps } from './deps.ts';

/** One use case run: a single timestamp and actor, fresh ids, and the events to publish after commit. */
export class ChangeSession {
  readonly now: Date;
  readonly actor: string;
  readonly #ids: WorkItemDeps['ids'];
  readonly #events: DomainEvent[] = [];

  constructor(deps: Pick<WorkItemDeps, 'clock' | 'ids'>, caller: Caller) {
    this.now = deps.clock.now();
    this.actor = caller.name;
    this.#ids = deps.ids;
  }

  newId(): string {
    return this.#ids.next();
  }

  /** Context for one history entry. */
  context(): ChangeContext {
    return { now: this.now, actor: this.actor, entryId: this.#ids.next() };
  }

  record(source: { pullEvents(): readonly DomainEvent[] }): void {
    this.#events.push(...source.pullEvents());
  }

  get events(): readonly DomainEvent[] {
    return this.#events;
  }
}

/** Run a change in a unit of work; publish its events only once it has been committed. */
export async function runChange<T, E>(
  deps: Pick<WorkItemDeps, 'clock' | 'ids' | 'events' | 'unitOfWork'>,
  caller: Caller,
  work: (session: ChangeSession) => Promise<Result<T, E>>,
): Promise<Result<Committed<T>, E>> {
  const session = new ChangeSession(deps, caller);
  const result = await deps.unitOfWork.run({ actor: caller.name, origin: caller.origin }, () => work(session));
  if (result.ok && session.events.length) await deps.events.publish(session.events);
  return result;
}
