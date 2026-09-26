import { create } from 'zustand';
import type { Database, Delta, Member, RecycledItem, Sprint, SprintCapacity, WorkItem, WorkItemLink } from '../../shared/types';

const USER_KEY = 'boards.currentUser';

export interface Toast {
  id: number;
  kind: 'info' | 'error' | 'success';
  text: string;
}

export type Connection = 'connecting' | 'live' | 'offline';

interface State {
  loaded: boolean;
  loadError: string | null;
  connection: Connection;
  version: number;
  settings: Database['settings'];
  members: Member[];
  sprints: Sprint[];
  capacities: SprintCapacity[];
  workItems: WorkItem[];
  links: WorkItemLink[];
  recycleBin: RecycledItem[];
  currentUserId: string | null;
  toasts: Toast[];
}

/**
 * Per-entity version stamps. Deltas can arrive twice (HTTP response and the SSE
 * stream) and out of order, so an entity is only overwritten by a newer version.
 */
const entityVersions = new Map<string, number>();

function readUser(): string | null {
  try {
    return localStorage.getItem(USER_KEY);
  } catch {
    return null;
  }
}

export const useStore = create<State>(() => ({
  loaded: false,
  loadError: null,
  connection: 'connecting',
  version: 0,
  settings: { projectName: '', teamName: '', workingDays: [1, 2, 3, 4, 5], areaPaths: [], backup: { autoEnabled: true, intervalHours: 24, retain: 14 } },
  members: [],
  sprints: [],
  capacities: [],
  workItems: [],
  links: [],
  recycleBin: [],
  currentUserId: readUser(),
  toasts: [],
}));

export function setDatabase(db: Database) {
  entityVersions.clear();
  const s = useStore.getState();
  const userValid = s.currentUserId && db.members.some((m) => m.id === s.currentUserId);
  useStore.setState({
    loaded: true,
    loadError: null,
    version: db.version,
    settings: db.settings,
    members: db.members,
    sprints: db.sprints,
    capacities: db.capacities,
    workItems: db.workItems,
    links: db.links,
    recycleBin: db.recycleBin ?? [],
    currentUserId: userValid ? s.currentUserId : (db.members.find((m) => m.active)?.id ?? null),
  });
}

function mergeList<T, K extends string | number>(
  prefix: string,
  list: T[],
  key: (t: T) => K,
  version: number,
  upserts: T[] | undefined,
  deletes: K[] | undefined,
): T[] {
  if (!upserts?.length && !deletes?.length) return list;
  const map = new Map(list.map((t) => [key(t), t] as const));
  let changed = false;
  for (const u of upserts ?? []) {
    const k = `${prefix}:${key(u)}`;
    if ((entityVersions.get(k) ?? 0) > version) continue;
    entityVersions.set(k, version);
    map.set(key(u), u);
    changed = true;
  }
  for (const d of deletes ?? []) {
    const k = `${prefix}:${d}`;
    if ((entityVersions.get(k) ?? 0) > version) continue;
    entityVersions.set(k, version);
    changed = map.delete(d) || changed;
  }
  if (!changed) return list;
  // Keep insertion order stable for existing entities.
  const result: T[] = [];
  const seen = new Set<K>();
  for (const t of list) {
    const k = key(t);
    if (map.has(k)) {
      result.push(map.get(k)!);
      seen.add(k);
    }
  }
  for (const [k, v] of map) if (!seen.has(k)) result.push(v);
  return result;
}

/** Returns true if a full reload is needed. */
export function applyDelta(delta: Delta): boolean {
  if (delta.reset) return true;
  const s = useStore.getState();
  const v = delta.version;
  const next: Partial<State> = {
    version: Math.max(s.version, v),
    workItems: mergeList('wi', s.workItems, (w) => w.id, v, delta.workItems, delta.deletedWorkItemIds),
    links: mergeList('ln', s.links, (l) => l.id, v, delta.links, delta.deletedLinkIds),
    sprints: mergeList('sp', s.sprints, (x) => x.id, v, delta.sprints, delta.deletedSprintIds),
    members: mergeList('mb', s.members, (m) => m.id, v, delta.members, delta.deletedMemberIds),
    capacities: mergeList('cp', s.capacities, (c) => c.sprintId, v, delta.capacities, delta.deletedSprintIds),
  };
  if (delta.settings && (entityVersions.get('settings') ?? 0) <= v) {
    entityVersions.set('settings', v);
    next.settings = delta.settings;
  }
  if (delta.recycleBin && (entityVersions.get('recycle') ?? 0) <= v) {
    entityVersions.set('recycle', v);
    next.recycleBin = delta.recycleBin;
  }
  useStore.setState(next);
  return false;
}

export function setCurrentUser(id: string) {
  try {
    localStorage.setItem(USER_KEY, id);
  } catch {
    // Storage may be unavailable (private mode); the choice just won't persist.
  }
  useStore.setState({ currentUserId: id });
}

let toastId = 0;
export function toast(text: string, kind: Toast['kind'] = 'info') {
  const id = ++toastId;
  useStore.setState((s) => ({ toasts: [...s.toasts, { id, kind, text }] }));
  setTimeout(() => dismissToast(id), kind === 'error' ? 7000 : 3500);
}

export function dismissToast(id: number) {
  useStore.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}
