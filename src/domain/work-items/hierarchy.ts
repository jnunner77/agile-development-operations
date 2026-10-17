import { err, ok, type Result } from '#shared/result.ts';
import { canBeParent, type WorkItemType } from '../process.ts';
import type { WorkItemError } from './errors.ts';
import type { WorkItemId } from './ids.ts';
import type { WorkItemRepository } from './repository.ts';
import type { WorkItemAggregate } from './work-item.ts';

/**
 * Check that `parentId` may be the parent of `child`: it exists, its type may hold the child's
 * type, and the child isn't already one of its ancestors. Returns the parent.
 */
export async function checkParent(
  child: { readonly id: number; readonly type: WorkItemType },
  parentId: WorkItemId | null | undefined,
  items: Pick<WorkItemRepository, 'findById'>,
): Promise<Result<WorkItemAggregate | undefined, WorkItemError>> {
  if (parentId == null) return ok(undefined);
  if (parentId === child.id) return err({ code: 'SELF_PARENT' });
  const parent = await items.findById(parentId);
  if (!parent) return err({ code: 'WORK_ITEM_NOT_FOUND', id: parentId });
  if (!canBeParent(parent.type, child.type)) return err({ code: 'PARENT_TYPE_NOT_ALLOWED', parentType: parent.type, childType: child.type });
  // Walk up from the proposed parent so the change can't create a cycle.
  const seen = new Set<number>();
  for (let p: WorkItemAggregate | undefined = parent; p; p = p.parentId != null ? await items.findById(p.parentId) : undefined) {
    if (p.id === child.id || seen.has(p.id)) return err({ code: 'CIRCULAR_HIERARCHY' });
    seen.add(p.id);
  }
  return ok(parent);
}

/** When a parent changes sprint, its open tasks that were in the old sprint go with it. */
export function tasksFollowingParent(children: readonly WorkItemAggregate[], fromSprint: string | null): WorkItemAggregate[] {
  return children.filter((c) => c.type === 'Task' && !c.isClosed && c.iterationId === fromSprint);
}

/** History note on children left without a parent. Children are orphaned, not deleted. */
export const orphanedNote = (parentId: number): string => `Parent #${parentId} was deleted`;
