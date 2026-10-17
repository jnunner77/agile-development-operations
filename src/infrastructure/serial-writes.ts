import type { SerialWrites } from '#application/ports.ts';

/** Runs work one piece at a time, in the order it was asked for. A failure doesn't block what follows. */
export class SerialQueue implements SerialWrites {
  #tail: Promise<unknown> = Promise.resolve();

  run<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(work, work);
    this.#tail = next.catch(() => undefined);
    return next;
  }
}
