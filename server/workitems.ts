import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  LINK_REVERSE,
  LINK_TYPES,
  WORK_ITEM_TYPES,
  canBeParent,
  defaultState,
  isClosed,
  stateDef,
  type LinkType,
} from '../shared/process';
import type { FieldChange, WorkItem, WorkItemLink } from '../shared/types';
import { isValidDate } from '../shared/dates';
import { badRequest, notFound } from './errors';
import { blankWorkItem } from './schema';
import type { Tx } from './store';

const RANK_GAP = 1000;

const num = z.number().finite().min(0).max(1_000_000).nullable();
const html = z.string().max(500_000);
const date = z
  .string()
  .nullable()
  .refine((v) => v === null || isValidDate(v), 'Expected a date in YYYY-MM-DD format');

export const workItemPatchSchema = z
  .object({
    title: z.string().trim().min(1, 'Title is required').max(255),
    state: z.string(),
    assignedTo: z.string().nullable(),
    areaPath: z.string().max(255),
    iterationId: z.string().nullable(),
    parentId: z.number().int().nullable(),
    priority: z.number().int().min(1).max(4).nullable(),
    effort: num,
    businessValue: num,
    timeCriticality: num,
    valueArea: z.string().max(64).nullable(),
    risk: z.string().max(64).nullable(),
    severity: z.string().max(64).nullable(),
    activity: z.string().max(64).nullable(),
    blocked: z.boolean(),
    originalEstimate: num,
    remainingWork: num,
    completedWork: num,
    startDate: date,
    targetDate: date,
    dueDate: date,
    description: html,
    acceptanceCriteria: html,
    reproSteps: html,
    systemInfo: html,
    foundInBuild: z.string().max(255),
    integratedInBuild: z.string().max(255),
    tags: z.array(z.string().trim().min(1).max(100)).max(100),
  })
  .partial()
  .strict();

export type WorkItemPatch = z.infer<typeof workItemPatchSchema>;

export const workItemCreateSchema = workItemPatchSchema.extend({
  type: z.enum(WORK_ITEM_TYPES),
  title: z.string().trim().min(1, 'Title is required').max(255),
  position: z.enum(['top', 'bottom']).optional(),
});

export type WorkItemCreate = z.infer<typeof workItemCreateSchema>;

export const moveSchema = z
  .object({
    /** Place the item immediately after this one. */
    afterId: z.number().int().nullable().optional(),
    /** Place the item immediately before this one. */
    beforeId: z.number().int().nullable().optional(),
    iterationId: z.string().nullable().optional(),
    parentId: z.number().int().nullable().optional(),
    state: z.string().optional(),
    assignedTo: z.string().nullable().optional(),
  })
  .strict();

export type MoveInput = z.infer<typeof moveSchema>;

export const bulkSchema = z
  .object({
    ids: z.array(z.number().int()).min(1).max(1000),
    changes: workItemPatchSchema.omit({ title: true }),
    addTags: z.array(z.string().trim().min(1)).optional(),
    removeTags: z.array(z.string()).optional(),
  })
  .strict();

export const linkSchema = z
  .object({
    sourceId: z.number().int(),
    targetId: z.number().int(),
    type: z.enum(LINK_TYPES),
    comment: z.string().max(1000).optional(),
  })
  .strict();

export const commentSchema = z.object({ text: z.string().trim().min(1, 'Comment is empty').max(100_000) }).strict();

export const hyperlinkSchema = z
  .object({
    url: z
      .string()
      .trim()
      .url()
      .refine((u) => /^https?:\/\//i.test(u), 'Only http(s) links are allowed'),
    comment: z.string().max(1000).optional(),
  })
  .strict();

function sameValue(a: unknown, b: unknown) {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => v === b[i]);
  return (a ?? null) === (b ?? null);
}

function sortedByRank(tx: Tx) {
  return [...tx.db.workItems].sort((a, b) => a.stackRank - b.stackRank);
}

function renumberRanks(tx: Tx) {
  sortedByRank(tx).forEach((w, idx) => {
    const rank = (idx + 1) * RANK_GAP;
    if (w.stackRank !== rank) {
      w.stackRank = rank;
      tx.touchItem(w.id);
    }
  });
}

function topRank(tx: Tx) {
  return tx.db.workItems.reduce((m, w) => Math.min(m, w.stackRank), RANK_GAP * 2) - RANK_GAP;
}

function bottomRank(tx: Tx) {
  return tx.db.workItems.reduce((m, w) => Math.max(m, w.stackRank), 0) + RANK_GAP;
}

/** Compute a stack rank that places `item` between two neighbours in the global order. */
function rankBetween(tx: Tx, itemId: number, afterId?: number | null, beforeId?: number | null): number {
  const ordered = sortedByRank(tx).filter((w) => w.id !== itemId);
  let lo: number | undefined;
  let hi: number | undefined;
  if (afterId != null) {
    const idx = ordered.findIndex((w) => w.id === afterId);
    if (idx < 0) throw notFound(`Work item ${afterId}`);
    lo = ordered[idx].stackRank;
    hi = beforeId != null ? tx.item(beforeId).stackRank : ordered[idx + 1]?.stackRank;
  } else if (beforeId != null) {
    const idx = ordered.findIndex((w) => w.id === beforeId);
    if (idx < 0) throw notFound(`Work item ${beforeId}`);
    hi = ordered[idx].stackRank;
    lo = ordered[idx - 1]?.stackRank;
  } else {
    return tx.item(itemId).stackRank;
  }
  if (lo === undefined) return hi! - RANK_GAP;
  if (hi === undefined || hi <= lo) return lo + (hi === undefined ? RANK_GAP : 0.5 * Math.max(hi - lo, 1e-3));
  return (lo + hi) / 2;
}

function validateParent(tx: Tx, item: Pick<WorkItem, 'id' | 'type'>, parentId: number | null) {
  if (parentId == null) return;
  if (parentId === item.id) throw badRequest('A work item cannot be its own parent');
  const parent = tx.item(parentId);
  if (!canBeParent(parent.type, item.type)) {
    throw badRequest(`A ${parent.type} cannot be the parent of a ${item.type}`);
  }
  // Walk up from the proposed parent to make sure we don't create a cycle.
  const seen = new Set<number>();
  for (let p: WorkItem | undefined = parent; p; p = p.parentId != null ? tx.db.workItems.find((w) => w.id === p!.parentId) : undefined) {
    if (p.id === item.id || seen.has(p.id)) throw badRequest('That parent would create a circular hierarchy');
    seen.add(p.id);
  }
}

function validateFields(tx: Tx, item: Pick<WorkItem, 'id' | 'type'>, patch: WorkItemPatch) {
  if (patch.state !== undefined && !stateDef(item.type, patch.state)) {
    throw badRequest(`"${patch.state}" is not a valid state for a ${item.type}`);
  }
  if (patch.iterationId != null) tx.sprint(patch.iterationId);
  if (patch.assignedTo != null) tx.member(patch.assignedTo);
  if (patch.parentId !== undefined) validateParent(tx, item, patch.parentId);
}

function normalizeTags(tags: string[]) {
  const seen = new Map<string, string>();
  for (const t of tags) {
    const tag = t.trim();
    if (tag && !seen.has(tag.toLowerCase())) seen.set(tag.toLowerCase(), tag);
  }
  return [...seen.values()];
}

/** Apply a field patch, recording history and derived fields. Returns the recorded changes. */
export function applyPatch(tx: Tx, item: WorkItem, patch: WorkItemPatch, note?: string): FieldChange[] {
  validateFields(tx, item, patch);
  const changes: FieldChange[] = [];
  const next: Record<string, unknown> = { ...patch };
  if (next.tags) next.tags = normalizeTags(next.tags as string[]);
  for (const [field, value] of Object.entries(next)) {
    const old = (item as unknown as Record<string, unknown>)[field];
    if (sameValue(old, value)) continue;
    changes.push({ field, oldValue: old ?? null, newValue: value ?? null });
    (item as unknown as Record<string, unknown>)[field] = value;
  }
  if (!changes.length) return changes;

  const stateChange = changes.find((c) => c.field === 'state');
  if (stateChange) {
    const reason = stateDef(item.type, item.state)?.reason ?? '';
    if (reason !== item.reason) {
      changes.push({ field: 'reason', oldValue: item.reason, newValue: reason });
      item.reason = reason;
    }
    const wasClosed = isClosed(item.type, String(stateChange.oldValue));
    const nowClosed = isClosed(item.type, item.state);
    if (nowClosed && !wasClosed) item.closedAt = tx.now;
    if (!nowClosed) item.closedAt = null;
    // Finishing a task burns down whatever work was left on it.
    if (item.type === 'Task' && item.state === 'Done' && item.remainingWork) {
      changes.push({ field: 'remainingWork', oldValue: item.remainingWork, newValue: 0 });
      item.remainingWork = 0;
    }
  }

  item.changedAt = tx.now;
  item.changedBy = tx.user;
  item.history.push({ id: randomUUID(), changedBy: tx.user, changedAt: tx.now, changes, ...(note ? { note } : {}) });
  tx.touchItem(item.id);
  return changes;
}

export function createWorkItem(tx: Tx, input: WorkItemCreate): WorkItem {
  const { type, position, ...fields } = input;
  const id = tx.db.nextWorkItemId++;
  const parent = fields.parentId != null ? tx.item(fields.parentId) : undefined;
  const stub = { id, type };
  validateFields(tx, stub, fields);

  const item = blankWorkItem({
    id,
    type,
    title: fields.title,
    areaPath: parent?.areaPath || tx.db.settings.areaPaths[0] || tx.db.settings.projectName,
    // Children inherit the sprint of their parent unless told otherwise.
    iterationId: fields.iterationId !== undefined ? fields.iterationId : type === 'Task' ? (parent?.iterationId ?? null) : null,
    stackRank: position === 'top' ? topRank(tx) : bottomRank(tx),
    createdAt: tx.now,
    createdBy: tx.user,
    changedAt: tx.now,
    changedBy: tx.user,
  });
  const { title: _title, iterationId: _iteration, ...rest } = fields;
  Object.assign(item, rest);
  if (item.tags.length) item.tags = normalizeTags(item.tags);
  item.state = fields.state ?? defaultState(type);
  item.reason = stateDef(type, item.state)?.reason ?? 'New';
  if (isClosed(type, item.state)) item.closedAt = tx.now;
  if (type === 'Task' && item.remainingWork == null && item.originalEstimate != null) item.remainingWork = item.originalEstimate;

  item.history.push({
    id: randomUUID(),
    changedBy: tx.user,
    changedAt: tx.now,
    note: 'Created',
    changes: [
      { field: 'title', oldValue: null, newValue: item.title },
      { field: 'state', oldValue: null, newValue: item.state },
      { field: 'iterationId', oldValue: null, newValue: item.iterationId },
      ...(item.parentId != null ? [{ field: 'parentId', oldValue: null, newValue: item.parentId }] : []),
      ...(item.remainingWork != null ? [{ field: 'remainingWork', oldValue: null, newValue: item.remainingWork }] : []),
      ...(item.effort != null ? [{ field: 'effort', oldValue: null, newValue: item.effort }] : []),
      ...(item.assignedTo != null ? [{ field: 'assignedTo', oldValue: null, newValue: item.assignedTo }] : []),
    ],
  });
  tx.db.workItems.push(item);
  tx.touchItem(id);
  return item;
}

/** Move open child tasks along with their parent when it changes sprint. */
function cascadeIteration(tx: Tx, parent: WorkItem, from: string | null) {
  for (const child of tx.db.workItems) {
    if (child.parentId !== parent.id || child.type !== 'Task') continue;
    if (isClosed(child.type, child.state) || child.iterationId !== from) continue;
    applyPatch(tx, child, { iterationId: parent.iterationId });
  }
}

/** Drag & drop: reorder and optionally change sprint, parent, state or assignee in one step. */
export function moveWorkItem(tx: Tx, id: number, input: MoveInput): WorkItem {
  const item = tx.item(id);
  const patch: WorkItemPatch = {};
  if (input.iterationId !== undefined) patch.iterationId = input.iterationId;
  if (input.parentId !== undefined) patch.parentId = input.parentId;
  if (input.state !== undefined) patch.state = input.state;
  if (input.assignedTo !== undefined) patch.assignedTo = input.assignedTo;
  const fromIteration = item.iterationId;
  applyPatch(tx, item, patch);
  if (patch.iterationId !== undefined && fromIteration !== item.iterationId) cascadeIteration(tx, item, fromIteration);
  if (input.afterId != null || input.beforeId != null) {
    const rank = rankBetween(tx, id, input.afterId, input.beforeId);
    if (rank !== item.stackRank) {
      item.stackRank = rank;
      tx.touchItem(id);
    }
    const ranks = tx.db.workItems.map((w) => w.stackRank).sort((a, b) => a - b);
    if (ranks.some((r, i) => i > 0 && r - ranks[i - 1] < 1e-6)) renumberRanks(tx);
  }
  return item;
}

export function updateWorkItem(tx: Tx, id: number, patch: WorkItemPatch): WorkItem {
  const item = tx.item(id);
  applyPatch(tx, item, patch);
  return item;
}

export function bulkUpdate(tx: Tx, input: z.infer<typeof bulkSchema>) {
  for (const id of input.ids) {
    const item = tx.item(id);
    const patch: WorkItemPatch = { ...input.changes };
    if (patch.state !== undefined && !stateDef(item.type, patch.state)) delete patch.state;
    if (patch.parentId !== undefined && patch.parentId !== null && !canBeParent(tx.item(patch.parentId).type, item.type)) delete patch.parentId;
    if (input.addTags?.length || input.removeTags?.length) {
      const remove = new Set((input.removeTags ?? []).map((t) => t.toLowerCase()));
      patch.tags = [...item.tags.filter((t) => !remove.has(t.toLowerCase())), ...(input.addTags ?? [])];
    }
    const from = item.iterationId;
    applyPatch(tx, item, patch);
    if (patch.iterationId !== undefined && from !== item.iterationId) cascadeIteration(tx, item, from);
  }
}

export function deleteWorkItem(tx: Tx, id: number) {
  const item = tx.item(id);
  // Children are orphaned rather than deleted, as in Azure DevOps.
  for (const child of tx.db.workItems.filter((w) => w.parentId === id)) {
    applyPatch(tx, child, { parentId: null }, `Parent #${id} was deleted`);
  }
  const links = tx.db.links.filter((l) => l.sourceId === id || l.targetId === id);
  tx.db.links = tx.db.links.filter((l) => !links.includes(l));
  links.forEach((l) => tx.deletedLinks.add(l.id));
  tx.db.workItems = tx.db.workItems.filter((w) => w.id !== id);
  tx.db.recycleBin.unshift({ item, links, deletedAt: tx.now, deletedBy: tx.user });
  tx.deletedItems.add(id);
  tx.recycleBin = true;
}

export function restoreWorkItem(tx: Tx, id: number) {
  const idx = tx.db.recycleBin.findIndex((r) => r.item.id === id);
  if (idx < 0) throw notFound(`Deleted work item ${id}`);
  const [{ item, links }] = tx.db.recycleBin.splice(idx, 1);
  const exists = (wid: number) => tx.db.workItems.some((w) => w.id === wid);
  if (item.parentId != null && !exists(item.parentId)) item.parentId = null;
  if (item.iterationId && !tx.db.sprints.some((s) => s.id === item.iterationId)) item.iterationId = null;
  if (item.assignedTo && !tx.db.members.some((m) => m.id === item.assignedTo)) item.assignedTo = null;
  item.history.push({ id: randomUUID(), changedBy: tx.user, changedAt: tx.now, changes: [], note: 'Restored from recycle bin' });
  tx.db.workItems.push(item);
  tx.touchItem(item.id);
  for (const link of links) {
    if (exists(link.sourceId) && exists(link.targetId)) {
      tx.db.links.push(link);
      tx.touchLink(link.id);
    }
  }
  tx.recycleBin = true;
  return item;
}

export function purgeWorkItem(tx: Tx, id: number) {
  const before = tx.db.recycleBin.length;
  tx.db.recycleBin = tx.db.recycleBin.filter((r) => r.item.id !== id);
  if (tx.db.recycleBin.length === before) throw notFound(`Deleted work item ${id}`);
  tx.recycleBin = true;
}

export function addLink(tx: Tx, input: z.infer<typeof linkSchema>): WorkItemLink {
  if (input.sourceId === input.targetId) throw badRequest('A work item cannot link to itself');
  tx.item(input.sourceId);
  tx.item(input.targetId);
  const reverse = LINK_REVERSE[input.type as LinkType];
  const dup = tx.db.links.find(
    (l) =>
      (l.sourceId === input.sourceId && l.targetId === input.targetId && l.type === input.type) ||
      (l.sourceId === input.targetId && l.targetId === input.sourceId && l.type === reverse),
  );
  if (dup) throw badRequest(`Work item ${input.targetId} is already linked as ${input.type}`);
  const link: WorkItemLink = {
    id: randomUUID(),
    sourceId: input.sourceId,
    targetId: input.targetId,
    type: input.type,
    comment: input.comment ?? '',
    createdBy: tx.user,
    createdAt: tx.now,
  };
  tx.db.links.push(link);
  tx.touchLink(link.id);
  for (const [a, b, t] of [
    [input.sourceId, input.targetId, input.type],
    [input.targetId, input.sourceId, reverse],
  ] as const) {
    const w = tx.item(a);
    w.history.push({ id: randomUUID(), changedBy: tx.user, changedAt: tx.now, changes: [], note: `Added ${t} link to #${b}` });
    tx.touchItem(a);
  }
  return link;
}

export function removeLink(tx: Tx, linkId: string) {
  const link = tx.db.links.find((l) => l.id === linkId);
  if (!link) throw notFound('Link');
  tx.db.links = tx.db.links.filter((l) => l.id !== linkId);
  tx.deletedLinks.add(linkId);
  for (const [a, b] of [
    [link.sourceId, link.targetId],
    [link.targetId, link.sourceId],
  ]) {
    const w = tx.db.workItems.find((x) => x.id === a);
    if (!w) continue;
    w.history.push({ id: randomUUID(), changedBy: tx.user, changedAt: tx.now, changes: [], note: `Removed link to #${b}` });
    tx.touchItem(a);
  }
}

export function addComment(tx: Tx, id: number, text: string) {
  const item = tx.item(id);
  const comment = { id: randomUUID(), author: tx.user, text, createdAt: tx.now, editedAt: null };
  item.comments.push(comment);
  item.changedAt = tx.now;
  item.changedBy = tx.user;
  tx.touchItem(id);
  return comment;
}

export function editComment(tx: Tx, id: number, commentId: string, text: string) {
  const item = tx.item(id);
  const comment = item.comments.find((c) => c.id === commentId);
  if (!comment) throw notFound('Comment');
  comment.text = text;
  comment.editedAt = tx.now;
  tx.touchItem(id);
  return comment;
}

export function deleteComment(tx: Tx, id: number, commentId: string) {
  const item = tx.item(id);
  const before = item.comments.length;
  item.comments = item.comments.filter((c) => c.id !== commentId);
  if (item.comments.length === before) throw notFound('Comment');
  tx.touchItem(id);
}

export function addHyperlink(tx: Tx, id: number, input: z.infer<typeof hyperlinkSchema>) {
  const item = tx.item(id);
  const link = { id: randomUUID(), url: input.url, comment: input.comment ?? '', addedBy: tx.user, addedAt: tx.now };
  item.hyperlinks.push(link);
  item.history.push({ id: randomUUID(), changedBy: tx.user, changedAt: tx.now, changes: [], note: `Added hyperlink ${input.url}` });
  tx.touchItem(id);
  return link;
}

export function removeHyperlink(tx: Tx, id: number, linkId: string) {
  const item = tx.item(id);
  const link = item.hyperlinks.find((h) => h.id === linkId);
  if (!link) throw notFound('Hyperlink');
  item.hyperlinks = item.hyperlinks.filter((h) => h.id !== linkId);
  item.history.push({ id: randomUUID(), changedBy: tx.user, changedAt: tx.now, changes: [], note: `Removed hyperlink ${link.url}` });
  tx.touchItem(id);
}

export function copyWorkItem(tx: Tx, id: number, includeChildren: boolean): WorkItem {
  const src = tx.item(id);
  const copyOne = (from: WorkItem, parentId: number | null, title: string) => {
    const copy = createWorkItem(tx, {
      type: from.type,
      title,
      parentId,
      iterationId: from.iterationId,
      assignedTo: from.assignedTo,
      areaPath: from.areaPath,
      priority: from.priority,
      effort: from.effort,
      businessValue: from.businessValue,
      timeCriticality: from.timeCriticality,
      valueArea: from.valueArea,
      risk: from.risk,
      severity: from.severity,
      activity: from.activity,
      originalEstimate: from.originalEstimate,
      remainingWork: from.remainingWork,
      startDate: from.startDate,
      targetDate: from.targetDate,
      dueDate: from.dueDate,
      description: from.description,
      acceptanceCriteria: from.acceptanceCriteria,
      reproSteps: from.reproSteps,
      systemInfo: from.systemInfo,
      foundInBuild: from.foundInBuild,
      tags: from.tags,
    });
    copy.stackRank = rankBetween(tx, copy.id, from.id, null);
    return copy;
  };
  const root = copyOne(src, src.parentId, `Copy of ${src.title}`);
  addLink(tx, { sourceId: root.id, targetId: src.id, type: 'Related', comment: 'Copied from' });
  if (includeChildren) {
    for (const child of tx.db.workItems.filter((w) => w.parentId === src.id && w.id !== root.id)) copyOne(child, root.id, child.title);
  }
  return root;
}
