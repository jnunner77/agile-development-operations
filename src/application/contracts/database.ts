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

export { MAX_MANUAL_SNAPSHOTS } from '#domain/snapshots/snapshot.ts';
export type { SnapshotKind, SnapshotMeta } from '#domain/snapshots/snapshot.ts';

/** A full export, as downloaded from Backups. Imports also accept a snapshot file or a bare database. */
export interface BackupFile {
  format: 'ado-clone-backup';
  exportedAt: Timestamp;
  exportedBy: string;
  data: Database;
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
