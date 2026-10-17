import { randomUUID } from 'node:crypto';
import { FieldChanges, type FieldInput } from '#domain/work-items/fields.ts';
import { WorkItemAggregate } from '#domain/work-items/work-item.ts';
import type { FieldChange, WorkItem } from '#domain/types.ts';
import type { Tx } from '#infrastructure/json-store/store.ts';

/**
 * Field changes made by the parts of the server not yet moved into the layers (GitHub moving an
 * item's state). They go through the work item aggregate, so the history, reason, closed date
 * and remaining-work rules are the same everywhere. Callers have already checked that the state
 * they set exists.
 */
export function applyPatch(tx: Tx, item: WorkItem, patch: FieldInput, note?: string): FieldChange[] {
  const changes = FieldChanges.validate(patch);
  if (!changes.ok) throw new Error(`Invalid change to work item ${item.id}: ${changes.error.code}`);
  const aggregate = WorkItemAggregate.reconstitute(item);
  const updated = aggregate.update(changes.value, { now: new Date(tx.now), actor: tx.user, entryId: randomUUID() }, note);
  if (!updated.ok) throw new Error(`Invalid change to work item ${item.id}: ${updated.error.code}`);
  if (updated.value.length) {
    Object.assign(item, aggregate.toSnapshot());
    tx.touchItem(item.id);
  }
  return [...updated.value];
}
