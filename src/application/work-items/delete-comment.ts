import type { WorkItemError } from '#domain/work-items/errors.ts';
import type { Result } from '#shared/result.ts';
import type { Caller } from '../caller.ts';
import type { Committed } from '../ports.ts';
import type { WorkItemDeps } from './deps.ts';
import { findItem, save } from './helpers.ts';
import { runChange } from './session.ts';

export interface DeleteCommentInput {
  readonly caller: Caller;
  readonly workItemId: number;
  readonly commentId: string;
}

export class DeleteComment {
  readonly #deps: WorkItemDeps;

  constructor(deps: WorkItemDeps) {
    this.#deps = deps;
  }

  async execute(input: DeleteCommentInput): Promise<Result<Committed<void>, WorkItemError>> {
    const actor = { memberId: input.caller.memberId, mayModerate: input.caller.mayModerateComments };
    return runChange(this.#deps, input.caller, async (session) => {
      const item = await findItem(this.#deps, input.workItemId);
      if (!item.ok) return item;
      const deleted = item.value.deleteComment(input.commentId, actor, session.now);
      if (deleted.ok) await save(this.#deps, session, item.value);
      return deleted;
    });
  }
}
