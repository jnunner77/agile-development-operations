import type { AddHyperlinkInput } from '#application/work-items/add-hyperlink.ts';
import type { AddLinkInput } from '#application/work-items/add-link.ts';
import type { BulkUpdateWorkItemsInput } from '#application/work-items/bulk-update-work-items.ts';
import type { CreateWorkItemInput } from '#application/work-items/create-work-item.ts';
import type { MoveWorkItemInput } from '#application/work-items/move-work-item.ts';
import { FIELD_NAMES, isFieldName, type FieldInput, type FieldName } from '#domain/work-items/fields.ts';
import { ok } from '#shared/result.ts';
import {
  arrayOf,
  boolean,
  integer,
  invalid,
  nullable,
  number,
  object,
  oneOf,
  optional,
  required,
  string,
  type Parsed,
} from '../http/parse.ts';

// Request bodies as the API documents them (docs/api.md). These check shape and JSON types only;
// the domain applies the business rules (lengths, ranges, states) to what comes through.

type Without<T, K extends keyof T> = Omit<T, K | 'caller'>;
type MutableFieldInput = { -readonly [K in FieldName]?: FieldInput[K] };
type FieldWriter = (value: unknown, path: string, out: MutableFieldInput) => Parsed<void>;

/** Read one field's JSON value into `out`. */
function field<K extends FieldName>(name: K, read: (value: unknown, path: string) => Parsed<Exclude<FieldInput[K], undefined>>): FieldWriter {
  return (value, path, out) => {
    const result = read(value, path);
    if (!result.ok) return result;
    out[name] = result.value;
    return ok(undefined);
  };
}

const text = string;
const nullableText = nullable(string);
const nullableNumber = nullable(number);

/** One reader per domain field: adding a field to the domain fails the build until it has one. */
const FIELD_READERS: { readonly [K in FieldName]-?: FieldWriter } = {
  title: field('title', text),
  state: field('state', text),
  assignedTo: field('assignedTo', nullableText),
  areaPath: field('areaPath', text),
  iterationId: field('iterationId', nullableText),
  parentId: field('parentId', nullable(integer)),
  priority: field('priority', nullableNumber),
  effort: field('effort', nullableNumber),
  businessValue: field('businessValue', nullableNumber),
  timeCriticality: field('timeCriticality', nullableNumber),
  valueArea: field('valueArea', nullableText),
  risk: field('risk', nullableText),
  severity: field('severity', nullableText),
  activity: field('activity', nullableText),
  blocked: field('blocked', boolean),
  originalEstimate: field('originalEstimate', nullableNumber),
  remainingWork: field('remainingWork', nullableNumber),
  completedWork: field('completedWork', nullableNumber),
  startDate: field('startDate', nullableText),
  targetDate: field('targetDate', nullableText),
  dueDate: field('dueDate', nullableText),
  description: field('description', text),
  acceptanceCriteria: field('acceptanceCriteria', text),
  reproSteps: field('reproSteps', text),
  systemInfo: field('systemInfo', text),
  foundInBuild: field('foundInBuild', text),
  integratedInBuild: field('integratedInBuild', text),
  tags: field('tags', arrayOf(string)),
};

/** Work item fields, in the order given. Other keys are refused unless listed in `extra`. */
export function parseFields(value: unknown, options: { extra?: readonly string[]; exclude?: readonly FieldName[]; where?: string } = {}): Parsed<FieldInput> {
  const allowed = [...FIELD_NAMES.filter((f) => !options.exclude?.includes(f)), ...(options.extra ?? [])];
  const where = options.where ?? '';
  const body = object(value, allowed, where);
  if (!body.ok) return body;
  const out: MutableFieldInput = {};
  for (const key of Object.keys(body.value)) {
    if (!isFieldName(key) || body.value[key] === undefined) continue;
    const read = FIELD_READERS[key](body.value[key], where ? `${where}.${key}` : key, out);
    if (!read.ok) return read;
  }
  return ok(out);
}

export function parseCreate(value: unknown): Parsed<Without<CreateWorkItemInput, never>> {
  const fields = parseFields(value, { extra: ['type', 'position'] });
  if (!fields.ok) return fields;
  const body = object(value);
  if (!body.ok) return body;
  const type = required(body.value, 'type', string);
  if (!type.ok) return type;
  const title = required(body.value, 'title', string);
  if (!title.ok) return title;
  const position = optional(body.value, 'position', oneOf(['top', 'bottom']));
  if (!position.ok) return position;
  return ok({ type: type.value, fields: fields.value, position: position.value });
}

export function parseMove(value: unknown): Parsed<Without<MoveWorkItemInput, 'id'>> {
  const body = object(value, ['afterId', 'beforeId', 'iterationId', 'parentId', 'state', 'assignedTo']);
  if (!body.ok) return body;
  const b = body.value;
  const afterId = optional(b, 'afterId', nullable(integer));
  if (!afterId.ok) return afterId;
  const beforeId = optional(b, 'beforeId', nullable(integer));
  if (!beforeId.ok) return beforeId;
  const iterationId = optional(b, 'iterationId', nullableText);
  if (!iterationId.ok) return iterationId;
  const parentId = optional(b, 'parentId', nullable(integer));
  if (!parentId.ok) return parentId;
  const state = optional(b, 'state', string);
  if (!state.ok) return state;
  const assignedTo = optional(b, 'assignedTo', nullableText);
  if (!assignedTo.ok) return assignedTo;
  return ok({
    afterId: afterId.value,
    beforeId: beforeId.value,
    iterationId: iterationId.value,
    parentId: parentId.value,
    state: state.value,
    assignedTo: assignedTo.value,
  });
}

export function parseBulk(value: unknown): Parsed<Without<BulkUpdateWorkItemsInput, never>> {
  const body = object(value, ['ids', 'changes', 'addTags', 'removeTags']);
  if (!body.ok) return body;
  const ids = required(body.value, 'ids', arrayOf(integer, { min: 1, max: 1000 }));
  if (!ids.ok) return ids;
  if (!('changes' in body.value)) return invalid('changes: Required');
  // The title is per item, so a bulk edit can't set it.
  const changes = parseFields(body.value['changes'], { exclude: ['title'], where: 'changes' });
  if (!changes.ok) return changes;
  const addTags = optional(body.value, 'addTags', arrayOf(string));
  if (!addTags.ok) return addTags;
  const removeTags = optional(body.value, 'removeTags', arrayOf(string));
  if (!removeTags.ok) return removeTags;
  return ok({ ids: ids.value, changes: changes.value, addTags: addTags.value, removeTags: removeTags.value });
}

export function parseIds(value: unknown): Parsed<{ readonly ids: number[] }> {
  const body = object(value);
  if (!body.ok) return body;
  const ids = required(body.value, 'ids', arrayOf(integer, { min: 1 }));
  return ids.ok ? ok({ ids: ids.value }) : ids;
}

export function parseCopy(value: unknown): Parsed<{ readonly includeChildren: boolean }> {
  const body = object(value ?? {});
  if (!body.ok) return body;
  const includeChildren = optional(body.value, 'includeChildren', boolean);
  return includeChildren.ok ? ok({ includeChildren: includeChildren.value ?? false }) : includeChildren;
}

export function parseLink(value: unknown): Parsed<Without<AddLinkInput, never>> {
  const body = object(value, ['sourceId', 'targetId', 'type', 'comment']);
  if (!body.ok) return body;
  const sourceId = required(body.value, 'sourceId', integer);
  if (!sourceId.ok) return sourceId;
  const targetId = required(body.value, 'targetId', integer);
  if (!targetId.ok) return targetId;
  const type = required(body.value, 'type', string);
  if (!type.ok) return type;
  const comment = optional(body.value, 'comment', string);
  if (!comment.ok) return comment;
  return ok({ sourceId: sourceId.value, targetId: targetId.value, type: type.value, comment: comment.value });
}

export function parseCommentText(value: unknown): Parsed<{ readonly text: string }> {
  const body = object(value, ['text']);
  if (!body.ok) return body;
  const commentText = required(body.value, 'text', string);
  return commentText.ok ? ok({ text: commentText.value }) : commentText;
}

export function parseHyperlink(value: unknown): Parsed<Without<AddHyperlinkInput, 'workItemId'>> {
  const body = object(value, ['url', 'comment']);
  if (!body.ok) return body;
  const url = required(body.value, 'url', string);
  if (!url.ok) return url;
  if (!URL.canParse(url.value.trim())) return invalid('url: Invalid URL');
  const comment = optional(body.value, 'comment', string);
  if (!comment.ok) return comment;
  return ok({ url: url.value, comment: comment.value });
}
