import { CommentText } from '#domain/work-items/comments.ts';
import type { WorkItemError } from '#domain/work-items/errors.ts';
import type { Comment } from '#domain/types.ts';
import type { Result } from '#shared/result.ts';
import type { Caller } from '../caller.ts';
import type { Committed } from '../ports.ts';
import type { WorkItemDeps } from './deps.ts';
import { findItem, save } from './helpers.ts';
import { runChange } from '../session.ts';

export interface EditCommentInput {
  readonly caller: Caller;
  readonly workItemId: number;
  readonly commentId: string;
  readonly text: string;
}

export class EditComment {
  readonly #deps: WorkItemDeps;

  constructor(deps: WorkItemDeps) {
    this.#deps = deps;
  }

  async execute(input: EditCommentInput): Promise<Result<Committed<Comment>, WorkItemError>> {
    const text = CommentText.of(input.text);
    if (!text.ok) return text;
    const actor = { memberId: input.caller.memberId, mayModerate: input.caller.mayModerateComments };
    return runChange(this.#deps, input.caller, async (session) => {
      const item = await findItem(this.#deps, input.workItemId);
      if (!item.ok) return item;
      const edited = item.value.editComment(input.commentId, text.value, actor, session.now);
      if (edited.ok) await save(this.#deps, session, item.value);
      return edited;
    });
  }
}
