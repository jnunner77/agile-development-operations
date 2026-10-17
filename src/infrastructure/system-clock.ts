import type { Clock } from '#application/ports.ts';

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/** A clock reading time from a function (milliseconds since the epoch), such as a test's. */
export class FunctionClock implements Clock {
  readonly #now: () => number;

  constructor(now: () => number) {
    this.#now = now;
  }

  now(): Date {
    return new Date(this.#now());
  }
}
