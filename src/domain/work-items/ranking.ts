import { err, ok, type Result } from '#shared/result.ts';
import type { WorkItemId } from './ids.ts';
import type { RankEntry } from './repository.ts';

/** Space between neighbouring ranks after renumbering, leaving room to insert between them. */
export const RANK_GAP = 1000;
/** Neighbours closer than this are renumbered so repeated halving never loses the order. */
const MIN_RANK_DISTANCE = 1e-6;

export const topRank = (ranks: readonly RankEntry[]): number => ranks.reduce((m, r) => Math.min(m, r.stackRank), RANK_GAP * 2) - RANK_GAP;
export const bottomRank = (ranks: readonly RankEntry[]): number => ranks.reduce((m, r) => Math.max(m, r.stackRank), 0) + RANK_GAP;

/**
 * The rank that places `itemId` right after `afterId`, or right before `beforeId`, in the
 * backlog order (one global order shared by every backlog and board).
 */
export function rankBetween(
  ranks: readonly RankEntry[],
  itemId: WorkItemId,
  afterId: WorkItemId | null,
  beforeId: WorkItemId | null,
  current: number,
): Result<number, { readonly code: 'WORK_ITEM_NOT_FOUND'; readonly id: number }> {
  const ordered = [...ranks].sort((a, b) => a.stackRank - b.stackRank).filter((r) => r.id !== itemId);
  let lo: number | undefined;
  let hi: number | undefined;
  if (afterId != null) {
    const idx = ordered.findIndex((r) => r.id === afterId);
    const after = ordered[idx];
    if (!after) return err({ code: 'WORK_ITEM_NOT_FOUND', id: afterId });
    lo = after.stackRank;
    if (beforeId != null) {
      const before = ranks.find((r) => r.id === beforeId);
      if (!before) return err({ code: 'WORK_ITEM_NOT_FOUND', id: beforeId });
      hi = before.stackRank;
    } else {
      hi = ordered[idx + 1]?.stackRank;
    }
  } else if (beforeId != null) {
    const idx = ordered.findIndex((r) => r.id === beforeId);
    const before = ordered[idx];
    if (!before) return err({ code: 'WORK_ITEM_NOT_FOUND', id: beforeId });
    hi = before.stackRank;
    lo = ordered[idx - 1]?.stackRank;
    if (lo === undefined) return ok(hi - RANK_GAP);
  } else {
    return ok(current);
  }
  if (hi === undefined) return ok(lo + RANK_GAP);
  if (hi <= lo) return ok(lo + 0.5 * Math.max(hi - lo, 1e-3));
  return ok((lo + hi) / 2);
}

export function needsRenumbering(ranks: readonly RankEntry[]): boolean {
  const sorted = ranks.map((r) => r.stackRank).sort((a, b) => a - b);
  return sorted.some((r, i) => i > 0 && r - (sorted[i - 1] ?? r) < MIN_RANK_DISTANCE);
}

/** Evenly spaced ranks in the current order, for the items whose rank changes. */
export function renumbered(ranks: readonly RankEntry[]): Map<WorkItemId, number> {
  const changes = new Map<WorkItemId, number>();
  [...ranks]
    .sort((a, b) => a.stackRank - b.stackRank)
    .forEach((r, idx) => {
      const rank = (idx + 1) * RANK_GAP;
      if (r.stackRank !== rank) changes.set(r.id, rank);
    });
  return changes;
}
