import type { SnapshotDetailsInput } from '#domain/snapshots/snapshot.ts';
import { ok } from '#shared/result.ts';
import { object, oneOf, optional, required, string, type Parsed } from '../http/parse.ts';

/** A snapshot's name and description; both optional. The domain checks their length. */
export function parseSnapshotDetails(value: unknown): Parsed<SnapshotDetailsInput> {
  const body = object(value, ['name', 'description']);
  if (!body.ok) return body;
  const name = optional(body.value, 'name', string);
  if (!name.ok) return name;
  const description = optional(body.value, 'description', string);
  if (!description.ok) return description;
  return ok({ name: name.value, description: description.value });
}

/** Taking a snapshot may send no body at all. */
export function parseNewSnapshot(value: unknown): Parsed<SnapshotDetailsInput> {
  return parseSnapshotDetails(value ?? {});
}

export function parseReset(value: unknown): Parsed<{ mode: 'empty' | 'demo' }> {
  const body = object(value);
  if (!body.ok) return body;
  const mode = required(body.value, 'mode', oneOf(['empty', 'demo']));
  if (!mode.ok) return mode;
  return ok({ mode: mode.value });
}
