import type { Database } from '#application/contracts/database.ts';
import type { Member, RecycledItem, Settings, Sprint, SprintCapacity, WorkItem, WorkItemLink } from '#domain/types.ts';
import { isWorkItemType, workItemDefaults } from '#domain/work-items/work-item.ts';

export const SCHEMA_VERSION = 1;

export function defaultSettings(): Settings {
  return {
    projectName: 'Fabrikam',
    teamName: 'Fabrikam Team',
    workingDays: [1, 2, 3, 4, 5],
    areaPaths: ['Fabrikam'],
    backup: { autoEnabled: true, intervalHours: 24, retain: 14 },
  };
}

export function emptyDatabase(settings: Partial<Settings> = {}): Database {
  return {
    schemaVersion: SCHEMA_VERSION,
    version: 1,
    nextWorkItemId: 1,
    settings: { ...defaultSettings(), ...settings },
    members: [],
    sprints: [],
    capacities: [],
    workItems: [],
    links: [],
    recycleBin: [],
  };
}

/** A complete work item from a partial one, filling every missing field with its default. */
export function blankWorkItem(partial: Partial<WorkItem> & Pick<WorkItem, 'id' | 'type' | 'title'>): WorkItem {
  const now = new Date().toISOString();
  return {
    ...workItemDefaults(partial.type),
    createdBy: 'System',
    createdAt: now,
    changedBy: 'System',
    changedAt: now,
    ...partial,
  };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Validate the overall shape of a database loaded from disk or imported from a
 * backup file, and fill in defaults for anything added in later versions.
 */
export function normalizeDatabase(raw: unknown): Database {
  if (!isObj(raw)) throw new Error('Backup is not a JSON object');
  // Accept both a bare database and a snapshot/export envelope ({ meta, data }).
  const data = raw['data'];
  const src = isObj(data) && Array.isArray(data['workItems']) ? data : raw;
  const list = (key: 'workItems' | 'sprints' | 'members'): unknown[] => {
    const value = src[key];
    if (!Array.isArray(value)) throw new Error(`Backup is missing the "${key}" list`);
    return value;
  };
  const rawItems = list('workItems');
  const rawSprints = list('sprints');
  const rawMembers = list('members');
  const workItems = rawItems.map((w, idx) => {
    if (!isObj(w) || typeof w['id'] !== 'number' || typeof w['title'] !== 'string') {
      throw new Error(`Work item #${idx + 1} in backup is invalid`);
    }
    const type = String(w['type']);
    if (!isWorkItemType(type)) throw new Error(`Work item ${w['id']} has unknown type "${type}"`);
    // The id, title and type are checked; every other field is filled in from the defaults.
    return blankWorkItem(w as unknown as WorkItem);
  });
  const maxId = workItems.reduce((m, w) => Math.max(m, w.id), 0);
  const version = src['version'];
  const nextId = src['nextWorkItemId'];
  const settings = src['settings'];
  const capacities = src['capacities'];
  const links = src['links'];
  const recycleBin = src['recycleBin'];
  const db: Database = {
    schemaVersion: SCHEMA_VERSION,
    version: typeof version === 'number' ? version : 1,
    nextWorkItemId: Math.max(typeof nextId === 'number' ? nextId : 1, maxId + 1),
    settings: { ...defaultSettings(), ...(isObj(settings) ? (settings as Partial<Settings>) : {}) },
    members: (rawMembers as Partial<Member>[]).map((m) => ({ ...m, username: typeof m.username === 'string' ? m.username : '' }) as Member),
    sprints: (rawSprints as Partial<Sprint>[]).map((s) => ({ goal: '', startDate: null, finishDate: null, ...s }) as Sprint),
    capacities: Array.isArray(capacities) ? (capacities as SprintCapacity[]) : [],
    workItems,
    links: Array.isArray(links) ? (links as WorkItemLink[]) : [],
    // Deleted items get the same defaults, so ones deleted before a field existed restore cleanly.
    recycleBin: Array.isArray(recycleBin)
      ? (recycleBin as RecycledItem[]).map((r) => ({ ...r, item: blankWorkItem(r.item), links: Array.isArray(r.links) ? r.links : [] }))
      : [],
  };
  db.settings.backup = { ...defaultSettings().backup, ...db.settings.backup };
  return db;
}
