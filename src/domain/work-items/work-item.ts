import { err, ok, type Result } from '#shared/result.ts';
import { WORK_ITEM_TYPES, defaultState, isClosed, stateDef, type WorkItemType } from '../process.ts';
import type { Comment, FieldChange, Hyperlink, WorkItem } from '../types.ts';
import { mayChangeComment, type CommentActor, type CommentText } from './comments.ts';
import type { WorkItemError } from './errors.ts';
import type { WorkItemEvent } from './events.ts';
import type { FieldChanges, FieldName, FieldValues } from './fields.ts';
import type { HyperlinkDraft } from './hyperlinks.ts';
import type { WorkItemId } from './ids.ts';

/** Who is making a change and when, plus the id for the history entry it records. */
export interface ChangeContext {
  readonly now: Date;
  readonly actor: string;
  readonly entryId: string;
}

export interface NewWorkItem {
  readonly id: WorkItemId;
  readonly type: WorkItemType;
  /** Must include the title. */
  readonly fields: FieldChanges;
  /** The parent named by `fields.parentId`, already checked by `checkParent`. */
  readonly parent: WorkItemAggregate | undefined;
  /** Area path for items without a parent to inherit one from. */
  readonly defaultAreaPath: string;
  readonly stackRank: number;
  readonly context: ChangeContext;
}

/** Which of a restored item's references still point at something that exists. */
export interface SurvivingReferences {
  readonly parent: boolean;
  readonly sprint: boolean;
  readonly member: boolean;
}

export function isWorkItemType(value: string): value is WorkItemType {
  return (WORK_ITEM_TYPES as readonly string[]).includes(value);
}

type Defaults = Omit<WorkItem, 'id' | 'type' | 'title' | 'createdBy' | 'createdAt' | 'changedBy' | 'changedAt'>;

/** Field values a new work item of this type starts with. */
export function workItemDefaults(type: WorkItemType): Defaults {
  return {
    state: defaultState(type),
    reason: 'New',
    assignedTo: null,
    areaPath: '',
    iterationId: null,
    parentId: null,
    stackRank: 0,
    priority: 2,
    effort: null,
    businessValue: null,
    timeCriticality: null,
    valueArea: type === 'Task' ? null : 'Business',
    risk: null,
    severity: type === 'Bug' ? '3 - Medium' : null,
    activity: null,
    blocked: false,
    originalEstimate: null,
    remainingWork: null,
    completedWork: null,
    startDate: null,
    targetDate: null,
    dueDate: null,
    description: '',
    acceptanceCriteria: '',
    reproSteps: '',
    systemInfo: '',
    foundInBuild: '',
    integratedInBuild: '',
    tags: [],
    hyperlinks: [],
    devLinks: [],
    comments: [],
    history: [],
    closedAt: null,
  };
}

/** A deep copy, so callers can never reach into an aggregate's state. */
export function cloneWorkItem(w: WorkItem): WorkItem {
  return {
    ...w,
    tags: [...w.tags],
    hyperlinks: w.hyperlinks.map((h) => ({ ...h })),
    devLinks: w.devLinks.map((d) => ({ ...d })),
    comments: w.comments.map((c) => ({ ...c })),
    history: w.history.map((h) => ({ ...h, changes: h.changes.map((c) => ({ ...c })) })),
  };
}

/**
 * A work item and everything it owns: its fields, history, comments and hyperlinks. Rules that
 * span several items (hierarchy, ranking, links) live in the domain services next to it.
 */
export class WorkItemAggregate {
  readonly #props: WorkItem;
  #events: WorkItemEvent[] = [];

  private constructor(props: WorkItem) {
    this.#props = props;
  }

  static create(input: NewWorkItem): Result<WorkItemAggregate, WorkItemError> {
    const { id, type, fields, parent, context } = input;
    const values = fields.values;
    if (values.title === undefined) return err({ code: 'TITLE_REQUIRED' });
    const state = values.state ?? defaultState(type);
    const def = stateDef(type, state);
    if (!def) return err({ code: 'INVALID_STATE', state, type });

    const at = context.now.toISOString();
    const props: WorkItem = {
      ...workItemDefaults(type),
      id,
      type,
      title: values.title,
      areaPath: parent?.areaPath || input.defaultAreaPath,
      // Tasks join their parent's sprint unless told otherwise.
      iterationId: values.iterationId !== undefined ? values.iterationId : type === 'Task' ? (parent?.iterationId ?? null) : null,
      stackRank: input.stackRank,
      createdAt: at,
      createdBy: context.actor,
      changedAt: at,
      changedBy: context.actor,
    };
    for (const name of fields.names()) {
      if (name !== 'title' && name !== 'iterationId') assignField(props, values, name);
    }
    props.tags = [...props.tags];
    props.state = state;
    props.reason = def.reason;
    if (isClosed(type, state)) props.closedAt = at;
    // A task's remaining work starts at its estimate.
    if (type === 'Task' && props.remainingWork == null && props.originalEstimate != null) props.remainingWork = props.originalEstimate;

    const created = (field: string, value: unknown): FieldChange[] => (value != null ? [{ field, oldValue: null, newValue: value }] : []);
    props.history.push({
      id: context.entryId,
      changedBy: context.actor,
      changedAt: at,
      note: 'Created',
      changes: [
        { field: 'title', oldValue: null, newValue: props.title },
        { field: 'state', oldValue: null, newValue: props.state },
        { field: 'iterationId', oldValue: null, newValue: props.iterationId },
        ...created('parentId', props.parentId),
        ...created('remainingWork', props.remainingWork),
        ...created('effort', props.effort),
        ...created('assignedTo', props.assignedTo),
      ],
    });

    const item = new WorkItemAggregate(props);
    item.#events.push({ type: 'WorkItemCreated', workItemId: id, workItemType: type, occurredAt: context.now });
    return ok(item);
  }

  /** Rebuild from stored data. Throws only if the data is corrupt. */
  static reconstitute(snapshot: WorkItem): WorkItemAggregate {
    if (!Number.isSafeInteger(snapshot.id)) throw new Error(`Stored work item has an invalid id: ${String(snapshot.id)}`);
    if (!isWorkItemType(snapshot.type)) throw new Error(`Stored work item ${snapshot.id} has unknown type "${String(snapshot.type)}"`);
    return new WorkItemAggregate(cloneWorkItem(snapshot));
  }

  get id(): WorkItemId {
    return this.#props.id as WorkItemId;
  }
  get type(): WorkItemType {
    return this.#props.type;
  }
  get title(): string {
    return this.#props.title;
  }
  get state(): string {
    return this.#props.state;
  }
  get isClosed(): boolean {
    return isClosed(this.#props.type, this.#props.state);
  }
  get parentId(): WorkItemId | null {
    return this.#props.parentId as WorkItemId | null;
  }
  get iterationId(): string | null {
    return this.#props.iterationId;
  }
  get assignedTo(): string | null {
    return this.#props.assignedTo;
  }
  get areaPath(): string {
    return this.#props.areaPath;
  }
  get stackRank(): number {
    return this.#props.stackRank;
  }
  get tags(): readonly string[] {
    return [...this.#props.tags];
  }

  /**
   * Apply field changes, recording what changed in the history along with the state's reason,
   * closed date and, for a task finished with work left, the burned-down remaining work.
   * Changes that leave a field as it was are skipped; if nothing changes nothing is recorded.
   * The caller checks references to other items, sprints and members first.
   */
  update(changes: FieldChanges, context: ChangeContext, note?: string): Result<readonly FieldChange[], WorkItemError> {
    const p = this.#props;
    const values = changes.values;
    if (values.state !== undefined && !stateDef(p.type, values.state)) {
      return err({ code: 'INVALID_STATE', state: values.state, type: p.type });
    }
    const recorded: FieldChange[] = [];
    for (const name of changes.names()) {
      const change = assignField(p, values, name);
      if (change) recorded.push(change);
    }
    if (!recorded.length) return ok(recorded);
    p.tags = [...p.tags]; // never share an array with the changes it came from

    const at = context.now.toISOString();
    const stateChange = recorded.find((c) => c.field === 'state');
    if (stateChange) {
      const reason = stateDef(p.type, p.state)?.reason ?? '';
      if (reason !== p.reason) {
        recorded.push({ field: 'reason', oldValue: p.reason, newValue: reason });
        p.reason = reason;
      }
      const wasClosed = isClosed(p.type, String(stateChange.oldValue));
      const nowClosed = isClosed(p.type, p.state);
      if (nowClosed && !wasClosed) p.closedAt = at;
      if (!nowClosed) p.closedAt = null;
      // Finishing a task burns down whatever work was left on it.
      if (p.type === 'Task' && p.state === 'Done' && p.remainingWork) {
        recorded.push({ field: 'remainingWork', oldValue: p.remainingWork, newValue: 0 });
        p.remainingWork = 0;
      }
    }

    p.changedAt = at;
    p.changedBy = context.actor;
    p.history.push({ id: context.entryId, changedBy: context.actor, changedAt: at, changes: recorded, ...(note ? { note } : {}) });
    this.#events.push({ type: 'WorkItemChanged', workItemId: p.id, fields: recorded.map((c) => c.field), occurredAt: context.now });
    return ok(recorded);
  }

  /** Move to a new place in the backlog order. Ordering isn't recorded in the history. */
  moveToRank(rank: number): boolean {
    if (rank === this.#props.stackRank) return false;
    this.#props.stackRank = rank;
    return true;
  }

  /** Record a history entry that changes no fields, such as a link being added. */
  addNote(note: string, context: ChangeContext): void {
    this.#props.history.push({ id: context.entryId, changedBy: context.actor, changedAt: context.now.toISOString(), changes: [], note });
  }

  addComment(input: { readonly id: string; readonly text: CommentText; readonly authorId: string | null }, context: { readonly now: Date; readonly actor: string }): Comment {
    const at = context.now.toISOString();
    const comment: Comment = { id: input.id, author: context.actor, authorId: input.authorId, text: input.text.value, createdAt: at, editedAt: null };
    this.#props.comments.push(comment);
    this.#props.changedAt = at;
    this.#props.changedBy = context.actor;
    this.#events.push({ type: 'CommentAdded', workItemId: this.#props.id, commentId: input.id, occurredAt: context.now });
    return { ...comment };
  }

  editComment(commentId: string, text: CommentText, actor: CommentActor, now: Date): Result<Comment, WorkItemError> {
    const comment = this.#props.comments.find((c) => c.id === commentId);
    if (!comment) return err({ code: 'COMMENT_NOT_FOUND', id: commentId });
    if (!mayChangeComment(comment, actor)) return err({ code: 'COMMENT_FORBIDDEN' });
    comment.text = text.value;
    comment.editedAt = now.toISOString();
    this.#events.push({ type: 'CommentEdited', workItemId: this.#props.id, commentId, occurredAt: now });
    return ok({ ...comment });
  }

  deleteComment(commentId: string, actor: CommentActor, now: Date): Result<void, WorkItemError> {
    const comment = this.#props.comments.find((c) => c.id === commentId);
    if (!comment) return err({ code: 'COMMENT_NOT_FOUND', id: commentId });
    if (!mayChangeComment(comment, actor)) return err({ code: 'COMMENT_FORBIDDEN' });
    this.#props.comments = this.#props.comments.filter((c) => c.id !== commentId);
    this.#events.push({ type: 'CommentDeleted', workItemId: this.#props.id, commentId, occurredAt: now });
    return ok(undefined);
  }

  addHyperlink(draft: HyperlinkDraft, hyperlinkId: string, context: ChangeContext): Hyperlink {
    const link: Hyperlink = { id: hyperlinkId, url: draft.url, comment: draft.comment, addedBy: context.actor, addedAt: context.now.toISOString() };
    this.#props.hyperlinks.push(link);
    this.addNote(`Added hyperlink ${draft.url}`, context);
    this.#events.push({ type: 'HyperlinkAdded', workItemId: this.#props.id, hyperlinkId, occurredAt: context.now });
    return { ...link };
  }

  removeHyperlink(hyperlinkId: string, context: ChangeContext): Result<void, WorkItemError> {
    const link = this.#props.hyperlinks.find((h) => h.id === hyperlinkId);
    if (!link) return err({ code: 'HYPERLINK_NOT_FOUND', id: hyperlinkId });
    this.#props.hyperlinks = this.#props.hyperlinks.filter((h) => h.id !== hyperlinkId);
    this.addNote(`Removed hyperlink ${link.url}`, context);
    this.#events.push({ type: 'HyperlinkRemoved', workItemId: this.#props.id, hyperlinkId, occurredAt: context.now });
    return ok(undefined);
  }

  /**
   * Bring the item back from the recycle bin. References to a parent, sprint or member that no
   * longer exists are dropped, since the item can't point at them any more.
   */
  restore(surviving: SurvivingReferences, context: ChangeContext): void {
    const p = this.#props;
    if (p.parentId != null && !surviving.parent) p.parentId = null;
    if (p.iterationId && !surviving.sprint) p.iterationId = null;
    if (p.assignedTo && !surviving.member) p.assignedTo = null;
    this.addNote('Restored from recycle bin', context);
    this.#events.push({ type: 'WorkItemRestored', workItemId: p.id, occurredAt: context.now });
  }

  pullEvents(): readonly WorkItemEvent[] {
    const events = this.#events;
    this.#events = [];
    return events;
  }

  toSnapshot(): WorkItem {
    return cloneWorkItem(this.#props);
  }
}

/** Set one field from validated values, returning the change if the value is different. */
function assignField<K extends FieldName>(props: WorkItem, values: FieldValues, name: K): FieldChange | undefined {
  const value = values[name];
  if (value === undefined) return undefined;
  const old: unknown = props[name];
  if (sameValue(old, value)) return undefined;
  props[name] = value;
  return { field: name, oldValue: old ?? null, newValue: value ?? null };
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => v === b[i]);
  return (a ?? null) === (b ?? null);
}
