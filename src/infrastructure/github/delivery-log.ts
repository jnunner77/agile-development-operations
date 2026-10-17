import type { DeliveryLog } from '#application/integrations/ports.ts';
import type { Delivery } from '#application/contracts/integrations.ts';

/** Deliveries shown on the settings page. */
const RECENT = 50;
/** Delivery ids remembered to skip duplicates. */
const REMEMBERED = 5000;

/** Recent deliveries and handled delivery ids, in memory: they start afresh with the server. */
export class MemoryDeliveryLog implements DeliveryLog {
  readonly #recent: Delivery[] = [];
  readonly #handled = new Set<string>();

  record(delivery: Delivery): void {
    this.#recent.unshift({ ...delivery, linked: [...delivery.linked] });
    this.#recent.length = Math.min(this.#recent.length, RECENT);
  }

  recent(): Delivery[] {
    return this.#recent.map((d) => ({ ...d, linked: [...d.linked] }));
  }

  wasHandled(id: string): boolean {
    return this.#handled.has(id);
  }

  markHandled(id: string): void {
    this.#handled.add(id);
    for (const oldest of this.#handled) {
      if (this.#handled.size <= REMEMBERED) break;
      this.#handled.delete(oldest);
    }
  }
}
