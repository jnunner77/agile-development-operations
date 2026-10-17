import { CommentText } from '#domain/work-items/comments.ts';
import type { WorkItemError } from '#domain/work-items/errors.ts';
import type { Comment } from '#domain/types.ts';
import { ok, type Result } from '#shared/result.ts';
import type { Caller } from '../caller.ts';
import type { Committed } from '../ports.ts';
import type { WorkItemDeps } from './deps.ts';
import { findItem, save } from './helpers.ts';
import { runChange } from '../session.ts';

export interface AddCommentInput {
  readonly caller: Caller;
  readonly workItemId: number;
  readonly text: string;
}

export class AddComment {
  readonly #deps: WorkItemDeps;

  constructor(deps: WorkItemDeps) {
    this.#deps = deps;
  }

  async execute(input: AddCommentInput): Promise<Result<Committed<Comment>, WorkItemError>> {
    const text = CommentText.of(input.text);
    if (!text.ok) return text;
    return runChange(this.#deps, input.caller, async (session) => {
      const item = await findItem(this.#deps, input.workItemId);
      if (!item.ok) return item;
      const comment = item.value.addComment({ id: session.newId(), text: text.value, authorId: input.caller.memberId }, session);
      await save(this.#deps, session, item.value);
      return ok(comment);
    });
  }
}
