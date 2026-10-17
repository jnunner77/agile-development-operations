import { err, ok, type Result } from '#shared/result.ts';

export const MAX_TAGS = 100;
export const MAX_TAG_LENGTH = 100;

export type TagError =
  | { readonly code: 'TAG_EMPTY' }
  | { readonly code: 'TOO_MANY_TAGS'; readonly max: number }
  | { readonly code: 'TEXT_TOO_LONG'; readonly field: 'tags'; readonly max: number };

/** Trim tags and drop blanks and case-insensitive duplicates, keeping the first spelling. */
export function normalizeTags(tags: readonly string[]): string[] {
  const seen = new Map<string, string>();
  for (const t of tags) {
    const tag = t.trim();
    if (tag && !seen.has(tag.toLowerCase())) seen.set(tag.toLowerCase(), tag);
  }
  return [...seen.values()];
}

/** Tags to set or add: at most 100, each 1 to 100 characters once trimmed. */
export function validateTags(tags: readonly string[]): Result<string[], TagError> {
  if (tags.length > MAX_TAGS) return err({ code: 'TOO_MANY_TAGS', max: MAX_TAGS });
  for (const raw of tags) {
    const tag = raw.trim();
    if (!tag) return err({ code: 'TAG_EMPTY' });
    if (tag.length > MAX_TAG_LENGTH) return err({ code: 'TEXT_TOO_LONG', field: 'tags', max: MAX_TAG_LENGTH });
  }
  return ok(normalizeTags(tags));
}

/** Tags to remove are matched, not stored, so only their number and length are limited. */
export function validateTagsToRemove(tags: readonly string[]): Result<string[], TagError> {
  if (tags.length > MAX_TAGS) return err({ code: 'TOO_MANY_TAGS', max: MAX_TAGS });
  if (tags.some((t) => t.length > MAX_TAG_LENGTH)) return err({ code: 'TEXT_TOO_LONG', field: 'tags', max: MAX_TAG_LENGTH });
  return ok([...tags]);
}

/**
 * An item's tags after removing some (ignoring case) and adding others. The result may not
 * exceed the tag limit, counting the tags the item already has.
 */
export function retag(
  current: readonly string[],
  add: readonly string[],
  remove: readonly string[],
): Result<string[], { readonly code: 'TOO_MANY_TAGS'; readonly max: number }> {
  const removed = new Set(remove.map((t) => t.toLowerCase()));
  const tags = normalizeTags([...current.filter((t) => !removed.has(t.toLowerCase())), ...add]);
  if (tags.length > MAX_TAGS) return err({ code: 'TOO_MANY_TAGS', max: MAX_TAGS });
  return ok(tags);
}
