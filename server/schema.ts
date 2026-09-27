import { WORK_ITEM_TYPES, defaultState } from '../shared/process';
import type { Database, Member, RecycledItem, Settings, Sprint, SprintCapacity, WorkItem, WorkItemLink } from '../shared/types';

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

export function blankWorkItem(partial: Partial<WorkItem> & Pick<WorkItem, 'id' | 'type' | 'title'>): WorkItem {
  const now = new Date().toISOString();
  return {
    state: defaultState(partial.type),
    reason: 'New',
    assignedTo: null,
    areaPath: '',
    iterationId: null,
    parentId: null,
    stackRank: 0,
    priority: 2,
    effort: null,
    businessValue: null,
    timeCriticality: null,
    valueArea: partial.type === 'Task' ? null : 'Business',
    risk: null,
    severity: partial.type === 'Bug' ? '3 - Medium' : null,
    activity: null,
    blocked: false,
    originalEstimate: null,
    remainingWork: null,
    completedWork: null,
    startDate: null,
    targetDate: null,
    dueDate: null,
    description: '',
    acceptanceCriteria: '',
    reproSteps: '',
    systemInfo: '',
    foundInBuild: '',
    integratedInBuild: '',
    tags: [],
    hyperlinks: [],
    comments: [],
    history: [],
    createdBy: 'System',
    createdAt: now,
    changedBy: 'System',
    changedAt: now,
    closedAt: null,
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
  const src = isObj(raw.data) && Array.isArray((raw.data as Record<string, unknown>).workItems) ? (raw.data as Record<string, unknown>) : raw;
  for (const key of ['workItems', 'sprints', 'members'] as const) {
    if (!Array.isArray(src[key])) throw new Error(`Backup is missing the "${key}" list`);
  }
  const workItems = (src.workItems as unknown[]).map((w, idx) => {
    if (!isObj(w) || typeof w.id !== 'number' || typeof w.title !== 'string') {
      throw new Error(`Work item #${idx + 1} in backup is invalid`);
    }
    if (!WORK_ITEM_TYPES.includes(w.type as never)) throw new Error(`Work item ${w.id} has unknown type "${String(w.type)}"`);
    return blankWorkItem(w as unknown as WorkItem);
  });
  const maxId = workItems.reduce((m, w) => Math.max(m, w.id), 0);
  const db: Database = {
    schemaVersion: SCHEMA_VERSION,
    version: typeof src.version === 'number' ? src.version : 1,
    nextWorkItemId: Math.max(typeof src.nextWorkItemId === 'number' ? src.nextWorkItemId : 1, maxId + 1),
    settings: { ...defaultSettings(), ...(isObj(src.settings) ? (src.settings as Partial<Settings>) : {}) },
    members: (src.members as Partial<Member>[]).map((m) => ({ ...m, username: typeof m.username === 'string' ? m.username : '' }) as Member),
    sprints: (src.sprints as Partial<Sprint>[]).map((s) => ({ goal: '', startDate: null, finishDate: null, ...s }) as Sprint),
    capacities: Array.isArray(src.capacities) ? (src.capacities as SprintCapacity[]) : [],
    workItems,
    links: Array.isArray(src.links) ? (src.links as WorkItemLink[]) : [],
    recycleBin: Array.isArray(src.recycleBin) ? (src.recycleBin as RecycledItem[]) : [],
  };
  db.settings.backup = { ...defaultSettings().backup, ...db.settings.backup };
  return db;
}
