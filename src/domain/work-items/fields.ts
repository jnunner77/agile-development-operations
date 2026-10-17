import { assertNever, err, ok, type Result } from '#shared/result.ts';
import { isValidDate } from '../dates.ts';
import type { WorkItem } from '../types.ts';
import { toWorkItemId, type WorkItemId } from './ids.ts';
import { validateTags, type TagError } from './tags.ts';

/** The fields people can set on a work item, in the order the form shows them. */
export const FIELD_NAMES = [
  'title',
  'state',
  'assignedTo',
  'areaPath',
  'iterationId',
  'parentId',
  'priority',
  'effort',
  'businessValue',
  'timeCriticality',
  'valueArea',
  'risk',
  'severity',
  'activity',
  'blocked',
  'originalEstimate',
  'remainingWork',
  'completedWork',
  'startDate',
  'targetDate',
  'dueDate',
  'description',
  'acceptanceCriteria',
  'reproSteps',
  'systemInfo',
  'foundInBuild',
  'integratedInBuild',
  'tags',
] as const;
export type FieldName = (typeof FIELD_NAMES)[number];

export const AMOUNT_FIELDS = ['effort', 'businessValue', 'timeCriticality', 'originalEstimate', 'remainingWork', 'completedWork'] as const;
export const CHOICE_FIELDS = ['valueArea', 'risk', 'severity', 'activity'] as const;
export const DATE_FIELDS = ['startDate', 'targetDate', 'dueDate'] as const;
export const RICH_TEXT_FIELDS = ['description', 'acceptanceCriteria', 'reproSteps', 'systemInfo'] as const;
export const SHORT_TEXT_FIELDS = ['areaPath', 'foundInBuild', 'integratedInBuild'] as const;

export const MAX_TITLE_LENGTH = 255;
export const MAX_SHORT_TEXT_LENGTH = 255;
export const MAX_CHOICE_LENGTH = 64;
export const MAX_RICH_TEXT_LENGTH = 500_000;
export const MAX_AMOUNT = 1_000_000;

/** Field values as received, before any rule is applied. */
export type FieldInput = {
  readonly [K in FieldName]?: K extends 'parentId' ? number | null : K extends 'tags' ? readonly string[] : WorkItem[K];
};

/** Field values that passed every rule, trimmed and normalised. */
export type FieldValues = { readonly [K in FieldName]?: WorkItem[K] };
type MutableFieldValues = { -readonly [K in keyof FieldValues]: FieldValues[K] };

export type FieldError =
  | { readonly code: 'TITLE_REQUIRED' }
  | { readonly code: 'TEXT_TOO_LONG'; readonly field: string; readonly max: number }
  | { readonly code: 'NUMBER_OUT_OF_RANGE'; readonly field: string; readonly min: number; readonly max: number }
  | { readonly code: 'NOT_AN_INTEGER'; readonly field: string }
  | { readonly code: 'INVALID_DATE'; readonly field: string }
  | TagError;

export function isFieldName(name: string): name is FieldName {
  return (FIELD_NAMES as readonly string[]).includes(name);
}

/**
 * A validated set of field changes. Values keep the order they were given in, which is the
 * order the changes appear in the item's history.
 */
export class FieldChanges {
  readonly #values: FieldValues;

  private constructor(values: FieldValues) {
    this.#values = Object.freeze(values);
    Object.freeze(this);
  }

  static readonly none = new FieldChanges({});

  static validate(input: FieldInput): Result<FieldChanges, FieldError> {
    const out: MutableFieldValues = {};
    for (const name of Object.keys(input)) {
      if (!isFieldName(name)) continue;
      const result = validateField(name, input, out);
      if (!result.ok) return result;
    }
    return ok(new FieldChanges(out));
  }

  get values(): FieldValues {
    return this.#values;
  }

  get isEmpty(): boolean {
    return this.names().length === 0;
  }

  /** The new parent, if the parent changes: `null` to remove it. */
  get parentId(): WorkItemId | null | undefined {
    // Validated as a work item id when the changes were built.
    return this.#values.parentId as WorkItemId | null | undefined;
  }

  has(name: FieldName): boolean {
    return this.#values[name] !== undefined;
  }

  names(): FieldName[] {
    return Object.keys(this.#values).filter(isFieldName);
  }

  without(...names: readonly FieldName[]): FieldChanges {
    const out: MutableFieldValues = { ...this.#values };
    for (const name of names) delete out[name];
    return new FieldChanges(out);
  }
}

function validateField(name: FieldName, input: FieldInput, out: MutableFieldValues): Result<void, FieldError> {
  switch (name) {
    case 'title': {
      const value = input.title;
      if (value === undefined) break;
      const title = value.trim();
      if (!title) return err({ code: 'TITLE_REQUIRED' });
      if (title.length > MAX_TITLE_LENGTH) return err({ code: 'TEXT_TOO_LONG', field: name, max: MAX_TITLE_LENGTH });
      out.title = title;
      break;
    }
    case 'state': {
      if (input.state !== undefined) out.state = input.state;
      break;
    }
    case 'assignedTo':
    case 'iterationId': {
      const value = input[name];
      if (value !== undefined) out[name] = value;
      break;
    }
    case 'blocked': {
      if (input.blocked !== undefined) out.blocked = input.blocked;
      break;
    }
    case 'parentId': {
      const value = input.parentId;
      if (value === undefined) break;
      if (value === null) {
        out.parentId = null;
        break;
      }
      const id = toWorkItemId(value);
      if (!id.ok) return err({ code: 'NOT_AN_INTEGER', field: name });
      out.parentId = id.value;
      break;
    }
    case 'priority': {
      const value = input.priority;
      if (value === undefined) break;
      if (value !== null) {
        if (!Number.isInteger(value)) return err({ code: 'NOT_AN_INTEGER', field: name });
        if (value < 1 || value > 4) return err({ code: 'NUMBER_OUT_OF_RANGE', field: name, min: 1, max: 4 });
      }
      out.priority = value;
      break;
    }
    case 'effort':
    case 'businessValue':
    case 'timeCriticality':
    case 'originalEstimate':
    case 'remainingWork':
    case 'completedWork': {
      const value = input[name];
      if (value === undefined) break;
      if (value !== null && !(Number.isFinite(value) && value >= 0 && value <= MAX_AMOUNT)) {
        return err({ code: 'NUMBER_OUT_OF_RANGE', field: name, min: 0, max: MAX_AMOUNT });
      }
      out[name] = value;
      break;
    }
    case 'valueArea':
    case 'risk':
    case 'severity':
    case 'activity': {
      const value = input[name];
      if (value === undefined) break;
      if (value !== null && value.length > MAX_CHOICE_LENGTH) return err({ code: 'TEXT_TOO_LONG', field: name, max: MAX_CHOICE_LENGTH });
      out[name] = value;
      break;
    }
    case 'startDate':
    case 'targetDate':
    case 'dueDate': {
      const value = input[name];
      if (value === undefined) break;
      if (value !== null && !isValidDate(value)) return err({ code: 'INVALID_DATE', field: name });
      out[name] = value;
      break;
    }
    case 'description':
    case 'acceptanceCriteria':
    case 'reproSteps':
    case 'systemInfo': {
      const value = input[name];
      if (value === undefined) break;
      if (value.length > MAX_RICH_TEXT_LENGTH) return err({ code: 'TEXT_TOO_LONG', field: name, max: MAX_RICH_TEXT_LENGTH });
      out[name] = value;
      break;
    }
    case 'areaPath':
    case 'foundInBuild':
    case 'integratedInBuild': {
      const value = input[name];
      if (value === undefined) break;
      if (value.length > MAX_SHORT_TEXT_LENGTH) return err({ code: 'TEXT_TOO_LONG', field: name, max: MAX_SHORT_TEXT_LENGTH });
      out[name] = value;
      break;
    }
    case 'tags': {
      const value = input.tags;
      if (value === undefined) break;
      const tags = validateTags(value);
      if (!tags.ok) return tags;
      out.tags = tags.value;
      break;
    }
    default:
      return assertNever(name);
  }
  return ok(undefined);
}
