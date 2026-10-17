import { DeletedWorkItem } from '#domain/recycle-bin/deleted-work-item.ts';
import { Link, type LinkDraft, type LinkId } from '#domain/links/link.ts';
import type { WorkItemError } from '#domain/work-items/errors.ts';
import { FieldChanges } from '#domain/work-items/fields.ts';
import { checkParent, orphanedNote, tasksFollowingParent } from '#domain/work-items/hierarchy.ts';
import { toWorkItemId } from '#domain/work-items/ids.ts';
import { bottomRank, topRank } from '#domain/work-items/ranking.ts';
import { WorkItemAggregate } from '#domain/work-items/work-item.ts';
import type { WorkItemType } from '#domain/process.ts';
import { err, ok, type Result } from '#shared/result.ts';
import type { WorkItemDeps, WorkItemsError } from './deps.ts';
import type { ChangeSession } from './session.ts';

// Steps shared by several work item use cases. They orchestrate; the rules are in the domain.

export async function findItem(deps: Pick<WorkItemDeps, 'items'>, rawId: number): Promise<Result<WorkItemAggregate, WorkItemError>> {
  const id = toWorkItemId(rawId);
  if (!id.ok) return id;
  const item = await deps.items.findById(id.value);
  return item ? ok(item) : err({ code: 'WORK_ITEM_NOT_FOUND', id: rawId });
}

/** Check that the sprint, member and parent a change points at exist and fit. Returns the parent. */
export async function checkReferences(
  deps: Pick<WorkItemDeps, 'items' | 'project'>,
  item: { readonly id: number; readonly type: WorkItemType },
  changes: FieldChanges,
): Promise<Result<WorkItemAggregate | undefined, WorkItemError>> {
  const { iterationId, assignedTo } = changes.values;
  if (iterationId != null && !(await deps.project.sprintExists(iterationId))) return err({ code: 'SPRINT_NOT_FOUND', id: iterationId });
  if (assignedTo != null && !(await deps.project.memberExists(assignedTo))) return err({ code: 'MEMBER_NOT_FOUND', id: assignedTo });
  return checkParent(item, changes.parentId, deps.items);
}

/**
 * Change an item's fields and save it. With `cascade`, open tasks in the item's old sprint
 * follow it to the new one (as drag and drop and bulk edits do).
 */
export async function editItem(
  deps: Pick<WorkItemDeps, 'items' | 'project'>,
  session: ChangeSession,
  item: WorkItemAggregate,
  changes: FieldChanges,
  options: { readonly cascade: boolean; readonly note?: string },
): Promise<Result<void, WorkItemError>> {
  const references = await checkReferences(deps, item, changes);
  if (!references.ok) return references;
  const fromSprint = item.iterationId;
  const updated = item.update(changes, session.context(), options.note);
  if (!updated.ok) return updated;
  if (!updated.value.length) return ok(undefined);
  await save(deps, session, item);
  if (!options.cascade || fromSprint === item.iterationId) return ok(undefined);

  const followers = tasksFollowingParent(await deps.items.findChildren(item.id), fromSprint);
  if (!followers.length) return ok(undefined);
  const move = FieldChanges.validate({ iterationId: item.iterationId });
  if (!move.ok) return move;
  for (const task of followers) {
    const moved = task.update(move.value, session.context());
    if (!moved.ok) return moved;
    await save(deps, session, task);
  }
  return ok(undefined);
}

export async function createItem(
  deps: Pick<WorkItemDeps, 'items' | 'project'>,
  session: ChangeSession,
  input: { readonly type: WorkItemType; readonly fields: FieldChanges; readonly position: 'top' | 'bottom' },
): Promise<Result<WorkItemAggregate, WorkItemError>> {
  const id = await deps.items.nextId();
  const parent = await checkReferences(deps, { id, type: input.type }, input.fields);
  if (!parent.ok) return parent;
  const ranks = await deps.items.ranks();
  const created = WorkItemAggregate.create({
    id,
    type: input.type,
    fields: input.fields,
    parent: parent.value,
    defaultAreaPath: await deps.project.defaultAreaPath(),
    stackRank: input.position === 'top' ? topRank(ranks) : bottomRank(ranks),
    context: session.context(),
  });
  if (!created.ok) return created;
  await save(deps, session, created.value);
  return created;
}

/** Move an item to the recycle bin with its links. Its children stay, without a parent. */
export async function removeItem(
  deps: Pick<WorkItemDeps, 'items' | 'links' | 'recycleBin' | 'project'>,
  session: ChangeSession,
  item: WorkItemAggregate,
): Promise<Result<void, WorkItemError>> {
  const orphan = FieldChanges.validate({ parentId: null });
  if (!orphan.ok) return orphan;
  for (const child of await deps.items.findChildren(item.id)) {
    const orphaned = await editItem(deps, session, child, orphan.value, { cascade: false, note: orphanedNote(item.id) });
    if (!orphaned.ok) return orphaned;
  }
  const links = await deps.links.findByItem(item.id);
  for (const link of links) {
    link.remove(session.now);
    await deps.links.delete(link.id);
    session.record(link);
  }
  await deps.items.delete(item.id);
  const deleted = DeletedWorkItem.of({ item, links, now: session.now, actor: session.actor });
  await deps.recycleBin.add(deleted);
  session.record(deleted);
  return ok(undefined);
}

/** Link two existing items and note the link in both of their histories. */
export async function linkItems(
  deps: Pick<WorkItemDeps, 'items' | 'links'>,
  session: ChangeSession,
  draft: LinkDraft,
): Promise<Result<Link, WorkItemsError>> {
  const source = await findItem(deps, draft.sourceId);
  if (!source.ok) return source;
  const target = await findItem(deps, draft.targetId);
  if (!target.ok) return target;
  const created = Link.create(draft, {
    id: session.newId() as LinkId,
    existing: await deps.links.findByItem(draft.sourceId),
    actor: session.actor,
    now: session.now,
  });
  if (!created.ok) return created;
  await deps.links.save(created.value);
  session.record(created.value);
  for (const { itemId, note } of created.value.historyNotes('added')) {
    const item = itemId === source.value.id ? source.value : target.value;
    item.addNote(note, session.context());
    await save(deps, session, item);
  }
  return created;
}

export async function save(deps: Pick<WorkItemDeps, 'items'>, session: ChangeSession, item: WorkItemAggregate): Promise<void> {
  await deps.items.save(item);
  session.record(item);
}
