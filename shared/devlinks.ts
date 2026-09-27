// Conventions for linking source control activity to work items, shared by the server
// (which parses GitHub events) and the client (which suggests branch names).

/** `AB#123` anywhere in a commit message, pull request title or description, or branch name. */
const MENTION = /\bAB#(\d{1,9})\b/gi;
/** Branch names like `wi/123-add-login`, `wi-123`, `feature/wi/123` or `AB123-fix`. */
const BRANCH = /(?:^|[/_-])(?:wi|ab)[/_-]?(\d{1,9})(?=$|[/_.-])/gi;

export function mentionedIds(text: string | null | undefined): number[] {
  const ids = new Set<number>();
  for (const m of (text ?? '').matchAll(MENTION)) ids.add(Number(m[1]));
  return [...ids];
}

export function branchIds(branch: string | null | undefined): number[] {
  const ids = new Set<number>(mentionedIds(branch));
  for (const m of (branch ?? '').matchAll(BRANCH)) ids.add(Number(m[1]));
  return [...ids];
}

/** Suggested branch name for a work item: `wi/123-short-title`. */
export function branchNameFor(id: number, title: string): string {
  const slug = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return slug ? `wi/${id}-${slug}` : `wi/${id}`;
}

export const mentionFor = (id: number) => `AB#${id}`;
