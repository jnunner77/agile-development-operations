import type { EventPublisher } from '#application/ports.ts';
import type { DomainEvent } from '#domain/events.ts';

export type EventListener = (event: DomainEvent) => void;

/** Delivers published domain events to listeners in this process, in order. */
export class LocalEventBus implements EventPublisher {
  readonly #listeners = new Set<EventListener>();

  subscribe(listener: EventListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async publish(events: readonly DomainEvent[]): Promise<void> {
    for (const event of events) for (const listener of this.#listeners) listener(event);
  }
}
