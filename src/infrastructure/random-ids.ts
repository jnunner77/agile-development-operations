import { randomUUID } from 'node:crypto';
import type { IdGenerator } from '#application/ports.ts';

export class RandomIds implements IdGenerator {
  next(): string {
    return randomUUID();
  }
}
