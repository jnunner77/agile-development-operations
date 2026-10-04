import { useEffect, useMemo, useState } from 'react';
import { sortSprints } from '../../../shared/sprints';
import { todayLocal } from '../../../shared/dates';
import type { WorkItem } from '../../../shared/types';
import { useStore } from '../store';

export function useItemsById() {
  const items = useStore((s) => s.workItems);
  return useMemo(() => new Map(items.map((w) => [w.id, w] as const)), [items]);
}

/** Children of each item, sorted by backlog rank. Key `null` holds root items. */
export function useChildrenMap() {
  const items = useStore((s) => s.workItems);
  return useMemo(() => childrenMap(items), [items]);
}

export function childrenMap(items: WorkItem[]) {
  const map = new Map<number | null, WorkItem[]>();
  for (const item of [...items].sort((a, b) => a.stackRank - b.stackRank)) {
    const list = map.get(item.parentId) ?? [];
    list.push(item);
    map.set(item.parentId, list);
  }
  return map;
}

export function useSortedSprints() {
  const sprints = useStore((s) => s.sprints);
  return useMemo(() => sortSprints(sprints), [sprints]);
}

export function useMembersById() {
  const members = useStore((s) => s.members);
  return useMemo(() => new Map(members.map((m) => [m.id, m] as const)), [members]);
}

/** Today's local date; refreshes after midnight. */
export function useToday() {
  const [today, setToday] = useState(todayLocal());
  useEffect(() => {
    const t = setInterval(() => setToday(todayLocal()), 60_000);
    return () => clearInterval(t);
  }, []);
  return today;
}

function readLocal<T>(key: string, initial: T): T {
  try {
    const raw = localStorage.getItem(`boards.${key}`);
    return raw ? ({ ...initial, ...JSON.parse(raw) } as T) : initial;
  } catch {
    return initial;
  }
}

/** Persist a small piece of UI state (view options, pane toggles) per browser. Follows `key` when it changes. */
export function useLocalState<T>(key: string, initial: T): [T, (v: T | ((prev: T) => T)) => void] {
  const [state, setState] = useState(() => ({ key, value: readLocal(key, initial) }));
  let current = state;
  if (state.key !== key) {
    current = { key, value: readLocal(key, initial) };
    setState(current);
  }
  const set = (v: T | ((prev: T) => T)) => {
    setState((prev) => {
      const base = prev.key === key ? prev.value : readLocal(key, initial);
      const next = typeof v === 'function' ? (v as (p: T) => T)(base) : v;
      try {
        localStorage.setItem(`boards.${key}`, JSON.stringify(next));
      } catch {
        // Non-essential; ignore storage failures.
      }
      return { key, value: next };
    });
  };
  return [current.value, set];
}

/**
 * Remembers which sections (cards, swimlanes) the current user has expanded or collapsed,
 * per browser: a default for all of them plus each one the user toggled since.
 * `keep` drops remembered choices for sections that no longer exist.
 */
export function useFolds(key: string, openByDefault: boolean, keep: (id: string) => boolean = () => true) {
  const userId = useStore((s) => s.currentUserId);
  const [folds, setFolds] = useLocalState<{ allOpen: boolean; open: Record<string, boolean> }>(`${key}.folds.${userId ?? 'anonymous'}`, {
    allOpen: openByDefault,
    open: {},
  });
  const isOpen = (id: string | number) => folds.open[id] ?? folds.allOpen;
  const setOpen = (id: string | number, open: boolean) =>
    setFolds((f) => {
      const next: Record<string, boolean> = {};
      for (const [k, v] of Object.entries(f.open)) if (keep(k)) next[k] = v;
      if (open === f.allOpen) delete next[id];
      else next[id] = open;
      return { ...f, open: next };
    });
  const setAll = (open: boolean) => setFolds({ allOpen: open, open: {} });
  return { isOpen, setOpen, setAll };
}

/** Rolled-up hours for an item and all of its descendants. */
export function rollup(item: WorkItem, children: Map<number | null, WorkItem[]>) {
  let remaining = 0;
  let completed = 0;
  let original = 0;
  let hasChildren = false;
  const walk = (w: WorkItem) => {
    for (const c of children.get(w.id) ?? []) {
      if (c.state === 'Removed') continue;
      hasChildren = true;
      const kids = children.get(c.id);
      if (kids?.length) walk(c);
      else {
        remaining += c.state === 'Done' ? 0 : (c.remainingWork ?? 0);
        completed += c.completedWork ?? 0;
        original += c.originalEstimate ?? 0;
      }
    }
  };
  walk(item);
  return { remaining, completed, original, hasChildren };
}

const NARROW_QUERY = '(max-width: 900px)';

/** True on phone- and small-tablet-sized screens. */
export function isNarrowScreen() {
  return typeof window !== 'undefined' && !!window.matchMedia?.(NARROW_QUERY).matches;
}

/** Re-renders when the screen crosses the narrow breakpoint (e.g. rotating a phone). */
export function useIsNarrow() {
  const [narrow, setNarrow] = useState(isNarrowScreen);
  useEffect(() => {
    const mq = window.matchMedia?.(NARROW_QUERY);
    if (!mq) return;
    const onChange = () => setNarrow(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return narrow;
}
