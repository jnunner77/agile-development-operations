import { err, ok, type Result } from '#shared/result.ts';
import type { Comment } from '../types.ts';

export const MAX_COMMENT_LENGTH = 100_000;

export type CommentError =
  | { readonly code: 'COMMENT_EMPTY' }
  | { readonly code: 'TEXT_TOO_LONG'; readonly field: 'text'; readonly max: number }
  | { readonly code: 'COMMENT_NOT_FOUND'; readonly id: string }
  | { readonly code: 'COMMENT_FORBIDDEN' };

/** Comment text (HTML), trimmed, never empty. */
export class CommentText {
  readonly #value: string;

  private constructor(value: string) {
    this.#value = value;
    Object.freeze(this);
  }

  static of(raw: string): Result<CommentText, CommentError> {
    const text = raw.trim();
    if (!text) return err({ code: 'COMMENT_EMPTY' });
    if (text.length > MAX_COMMENT_LENGTH) return err({ code: 'TEXT_TOO_LONG', field: 'text', max: MAX_COMMENT_LENGTH });
    return ok(new CommentText(text));
  }

  get value(): string {
    return this.#value;
  }
}

/** Who is changing a comment: their member id, and whether they may change anyone's. */
export interface CommentActor {
  readonly memberId: string | null;
  readonly mayModerate: boolean;
}

/** A comment may be changed by its author or by someone allowed to moderate. */
export function mayChangeComment(comment: Comment, actor: CommentActor): boolean {
  return actor.mayModerate || (!!comment.authorId && comment.authorId === actor.memberId);
}
