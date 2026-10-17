import { err, ok, type Result } from '#shared/result.ts';

export const MAX_HYPERLINK_COMMENT_LENGTH = 1000;

export type HyperlinkError =
  | { readonly code: 'HYPERLINK_NOT_HTTP' }
  | { readonly code: 'HYPERLINK_NOT_FOUND'; readonly id: string }
  | { readonly code: 'TEXT_TOO_LONG'; readonly field: 'comment'; readonly max: number };

/**
 * A web link to attach to a work item. Only http(s) links are allowed, so a stored link can
 * never run script (`javascript:`) or open local files when someone clicks it.
 */
export class HyperlinkDraft {
  readonly #url: string;
  readonly #comment: string;

  private constructor(url: string, comment: string) {
    this.#url = url;
    this.#comment = comment;
    Object.freeze(this);
  }

  static of(input: { readonly url: string; readonly comment?: string | undefined }): Result<HyperlinkDraft, HyperlinkError> {
    const url = input.url.trim();
    if (!/^https?:\/\/[^\s/?#]+/i.test(url)) return err({ code: 'HYPERLINK_NOT_HTTP' });
    const comment = input.comment ?? '';
    if (comment.length > MAX_HYPERLINK_COMMENT_LENGTH) return err({ code: 'TEXT_TOO_LONG', field: 'comment', max: MAX_HYPERLINK_COMMENT_LENGTH });
    return ok(new HyperlinkDraft(url, comment));
  }

  get url(): string {
    return this.#url;
  }

  get comment(): string {
    return this.#comment;
  }
}
