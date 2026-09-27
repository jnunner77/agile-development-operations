import type { LinkType, WorkItemType } from './process';

/** Calendar date in YYYY-MM-DD form. */
export type DateString = string;
/** ISO-8601 timestamp. */
export type Timestamp = string;

export interface Member {
  id: string;
  name: string;
  /** Short unique login-style handle, e.g. "jnunner". Empty when not set. */
  username: string;
  email: string;
  color: string;
  active: boolean;
}

export interface DateRange {
  start: DateString;
  end: DateString;
}

export interface Sprint {
  id: string;
  name: string;
  startDate: DateString | null;
  finishDate: DateString | null;
  goal: string;
}

export interface ActivityCapacity {
  activity: string;
  /** Hours per working day. */
  capacityPerDay: number;
}

export interface MemberCapacity {
  memberId: string;
  activities: ActivityCapacity[];
  daysOff: DateRange[];
}

export interface SprintCapacity {
  sprintId: string;
  teamDaysOff: DateRange[];
  members: MemberCapacity[];
}

export interface Comment {
  id: string;
  author: string;
  text: string;
  createdAt: Timestamp;
  editedAt: Timestamp | null;
}

export interface FieldChange {
  field: string;
  oldValue: unknown;
  newValue: unknown;
}

export interface HistoryEntry {
  id: string;
  changedBy: string;
  changedAt: Timestamp;
  changes: FieldChange[];
  note?: string;
}

export interface Hyperlink {
  id: string;
  url: string;
  comment: string;
  addedBy: string;
  addedAt: Timestamp;
}

export interface WorkItem {
  id: number;
  type: WorkItemType;
  title: string;
  state: string;
  reason: string;
  assignedTo: string | null;
  areaPath: string;
  /** Sprint id, or null when the item lives on the product backlog. */
  iterationId: string | null;
  parentId: number | null;
  /** Backlog order; lower comes first. */
  stackRank: number;

  priority: number | null;
  /** Story points. */
  effort: number | null;
  businessValue: number | null;
  timeCriticality: number | null;
  valueArea: string | null;
  risk: string | null;
  severity: string | null;
  activity: string | null;
  blocked: boolean;

  /** Hours. */
  originalEstimate: number | null;
  remainingWork: number | null;
  completedWork: number | null;

  startDate: DateString | null;
  targetDate: DateString | null;
  dueDate: DateString | null;

  description: string;
  acceptanceCriteria: string;
  reproSteps: string;
  systemInfo: string;
  foundInBuild: string;
  integratedInBuild: string;

  tags: string[];
  hyperlinks: Hyperlink[];
  comments: Comment[];
  history: HistoryEntry[];

  createdBy: string;
  createdAt: Timestamp;
  changedBy: string;
  changedAt: Timestamp;
  closedAt: Timestamp | null;
}

/** Link stored once in canonical direction; `type` is how the source sees the target. */
export interface WorkItemLink {
  id: string;
  sourceId: number;
  targetId: number;
  type: LinkType;
  comment: string;
  createdBy: string;
  createdAt: Timestamp;
}

export interface BackupSettings {
  autoEnabled: boolean;
  intervalHours: number;
  retain: number;
}

export interface Settings {
  projectName: string;
  teamName: string;
  /** 0 = Sunday ... 6 = Saturday */
  workingDays: number[];
  areaPaths: string[];
  backup: BackupSettings;
}

export interface Database {
  schemaVersion: number;
  version: number;
  nextWorkItemId: number;
  settings: Settings;
  members: Member[];
  sprints: Sprint[];
  capacities: SprintCapacity[];
  workItems: WorkItem[];
  links: WorkItemLink[];
  recycleBin: RecycledItem[];
}

/** A deleted work item, kept so it can be restored. */
export interface RecycledItem {
  item: WorkItem;
  links: WorkItemLink[];
  deletedAt: Timestamp;
  deletedBy: string;
}

export type SnapshotKind = 'manual' | 'auto' | 'pre-restore' | 'pre-import' | 'pre-reset';

export interface SnapshotMeta {
  id: string;
  name: string;
  description: string;
  kind: SnapshotKind;
  createdAt: Timestamp;
  createdBy: string;
  sizeBytes: number;
  stats: { workItems: number; sprints: number; members: number };
}

/** Incremental change set broadcast after every mutation. */
export interface Delta {
  version: number;
  reset?: boolean;
  workItems?: WorkItem[];
  deletedWorkItemIds?: number[];
  links?: WorkItemLink[];
  deletedLinkIds?: string[];
  sprints?: Sprint[];
  deletedSprintIds?: string[];
  members?: Member[];
  deletedMemberIds?: string[];
  capacities?: SprintCapacity[];
  settings?: Settings;
  recycleBin?: RecycledItem[];
}

export interface MutationResult<T = unknown> {
  delta: Delta;
  result?: T;
}
