// Contracts between the server and its clients: the whole-project document, its change
// sets, and snapshot metadata. Plain data; the business records come from the domain.

import type { Member, RecycledItem, Settings, Sprint, SprintCapacity, Timestamp, WorkItem, WorkItemLink } from '#domain/types.ts';

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

export type SnapshotKind = 'manual' | 'auto' | 'pre-restore' | 'pre-import' | 'pre-reset';

/** Snapshots people take themselves (not automatic or safety ones) are capped at this many. */
export const MAX_MANUAL_SNAPSHOTS = 50;

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
