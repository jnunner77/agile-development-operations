import type { Brand } from '#shared/brand.ts';
import { err, ok, type Result } from '#shared/result.ts';

export type WorkItemId = Brand<number, 'WorkItemId'>;

export type WorkItemIdError = { readonly code: 'INVALID_WORK_ITEM_ID'; readonly value: number };

/**
 * Any safe integer is a well-formed work item id. Whether an item with that id exists is a
 * separate question, answered by the repository.
 */
export function toWorkItemId(value: number): Result<WorkItemId, WorkItemIdError> {
  if (!Number.isSafeInteger(value)) return err({ code: 'INVALID_WORK_ITEM_ID', value });
  return ok(value as WorkItemId);
}
