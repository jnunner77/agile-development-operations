import { LinkDraft } from '#domain/links/link.ts';
import { toWorkItemId } from '#domain/work-items/ids.ts';
import type { WorkItemLink } from '#domain/types.ts';
import { ok, type Result } from '#shared/result.ts';
import type { Caller } from '../caller.ts';
import type { Committed } from '../ports.ts';
import type { WorkItemDeps, WorkItemsError } from './deps.ts';
import { linkItems } from './helpers.ts';
import { runChange } from './session.ts';

export interface AddLinkInput {
  readonly caller: Caller;
  readonly sourceId: number;
  readonly targetId: number;
  readonly type: string;
  readonly comment?: string | undefined;
}

export class AddLink {
  readonly #deps: WorkItemDeps;

  constructor(deps: WorkItemDeps) {
    this.#deps = deps;
  }

  async execute(input: AddLinkInput): Promise<Result<Committed<WorkItemLink>, WorkItemsError>> {
    const sourceId = toWorkItemId(input.sourceId);
    if (!sourceId.ok) return sourceId;
    const targetId = toWorkItemId(input.targetId);
    if (!targetId.ok) return targetId;
    const draft = LinkDraft.of({ sourceId: sourceId.value, targetId: targetId.value, type: input.type, comment: input.comment });
    if (!draft.ok) return draft;
    return runChange(this.#deps, input.caller, async (session) => {
      const link = await linkItems(this.#deps, session, draft.value);
      return link.ok ? ok(link.value.toSnapshot()) : link;
    });
  }
}
