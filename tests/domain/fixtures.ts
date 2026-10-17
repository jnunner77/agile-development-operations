import assert from 'node:assert/strict';
import type { WorkItemType } from '#domain/process.ts';
import { FieldChanges, type FieldInput } from '#domain/work-items/fields.ts';
import type { WorkItemId } from '#domain/work-items/ids.ts';
import { WorkItemAggregate, type ChangeContext } from '#domain/work-items/work-item.ts';

export const NOW = new Date('2026-03-02T10:00:00.000Z');
export const LATER = new Date('2026-03-03T10:00:00.000Z');

/** Test fixtures may brand ids directly. */
export const id = (n: number): WorkItemId => n as WorkItemId;

export const ctx = (entryId = 'h1', now = NOW, actor = 'Ann'): ChangeContext => ({ now, actor, entryId });

export function changes(input: FieldInput): FieldChanges {
  const result = FieldChanges.validate(input);
  assert.ok(result.ok, JSON.stringify(result));
  return result.value;
}

export function newItem(
  type: WorkItemType,
  fields: FieldInput = {},
  options: { id?: number; parent?: WorkItemAggregate; rank?: number; context?: ChangeContext } = {},
): WorkItemAggregate {
  const result = WorkItemAggregate.create({
    id: id(options.id ?? 1),
    type,
    fields: changes({ title: `${type} item`, ...fields }),
    parent: options.parent,
    defaultAreaPath: 'Fabrikam',
    stackRank: options.rank ?? 1000,
    context: options.context ?? ctx('created'),
  });
  assert.ok(result.ok, JSON.stringify(result));
  result.value.pullEvents();
  return result.value;
}
