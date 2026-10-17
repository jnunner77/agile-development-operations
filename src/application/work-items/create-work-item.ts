import { FieldChanges, type FieldInput } from '#domain/work-items/fields.ts';
import type { WorkItemError } from '#domain/work-items/errors.ts';
import { isWorkItemType } from '#domain/work-items/work-item.ts';
import type { WorkItem } from '#domain/types.ts';
import { err, ok, type Result } from '#shared/result.ts';
import type { Caller } from '../caller.ts';
import type { Committed } from '../ports.ts';
import type { WorkItemDeps } from './deps.ts';
import { createItem } from './helpers.ts';
import { runChange } from '../session.ts';

export interface CreateWorkItemInput {
  readonly caller: Caller;
  readonly type: string;
  readonly fields: FieldInput;
  /** Where it goes in the backlog order. Default: the bottom. */
  readonly position?: 'top' | 'bottom' | undefined;
}

export class CreateWorkItem {
  readonly #deps: WorkItemDeps;

  constructor(deps: WorkItemDeps) {
    this.#deps = deps;
  }

  async execute(input: CreateWorkItemInput): Promise<Result<Committed<WorkItem>, WorkItemError>> {
    const { type } = input;
    if (!isWorkItemType(type)) return err({ code: 'UNKNOWN_WORK_ITEM_TYPE', type });
    const fields = FieldChanges.validate(input.fields);
    if (!fields.ok) return fields;
    if (fields.value.values.title === undefined) return err({ code: 'TITLE_REQUIRED' });
    return runChange(this.#deps, input.caller, async (session) => {
      const created = await createItem(this.#deps, session, { type, fields: fields.value, position: input.position ?? 'bottom' });
      return created.ok ? ok(created.value.toSnapshot()) : created;
    });
  }
}
