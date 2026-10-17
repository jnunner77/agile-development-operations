import { canBeParent, stateDef, type WorkItemType } from '../process.ts';
import type { FieldChanges } from './fields.ts';
import type { WorkItemAggregate } from './work-item.ts';

/**
 * A bulk edit applies one set of changes to items of different types. A state or parent that
 * doesn't fit an item's type is skipped for that item instead of failing the whole edit.
 */
export function bulkChangesFor(item: WorkItemAggregate, changes: FieldChanges, parentType: WorkItemType | undefined): FieldChanges {
  let result = changes;
  const { state } = changes.values;
  if (state !== undefined && !stateDef(item.type, state)) result = result.without('state');
  if (parentType !== undefined && !canBeParent(parentType, item.type)) result = result.without('parentId');
  return result;
}
