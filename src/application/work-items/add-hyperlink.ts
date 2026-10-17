import type { WorkItemError } from '#domain/work-items/errors.ts';
import { HyperlinkDraft } from '#domain/work-items/hyperlinks.ts';
import type { Hyperlink } from '#domain/types.ts';
import { ok, type Result } from '#shared/result.ts';
import type { Caller } from '../caller.ts';
import type { Committed } from '../ports.ts';
import type { WorkItemDeps } from './deps.ts';
import { findItem, save } from './helpers.ts';
import { runChange } from './session.ts';

export interface AddHyperlinkInput {
  readonly caller: Caller;
  readonly workItemId: number;
  readonly url: string;
  readonly comment?: string | undefined;
}

export class AddHyperlink {
  readonly #deps: WorkItemDeps;

  constructor(deps: WorkItemDeps) {
    this.#deps = deps;
  }

  async execute(input: AddHyperlinkInput): Promise<Result<Committed<Hyperlink>, WorkItemError>> {
    const draft = HyperlinkDraft.of({ url: input.url, comment: input.comment });
    if (!draft.ok) return draft;
    return runChange(this.#deps, input.caller, async (session) => {
      const item = await findItem(this.#deps, input.workItemId);
      if (!item.ok) return item;
      const link = item.value.addHyperlink(draft.value, session.newId(), session.context());
      await save(this.#deps, session, item.value);
      return ok(link);
    });
  }
}
