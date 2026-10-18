import type { Brand } from '#shared/brand.ts';
import { err, ok, type Result } from '#shared/result.ts';
import type { BackupSettings, Settings, Timestamp } from '../types.ts';

// Snapshots are point-in-time copies of the whole project. People take them by hand, the server
// takes them on a schedule, and every restore, import or reset takes one first so it can be undone.

export type SnapshotKind = 'manual' | 'auto' | 'pre-restore' | 'pre-import' | 'pre-reset';
export type SnapshotId = Brand<string, 'SnapshotId'>;

/** Snapshots people take themselves (not automatic or safety ones) are capped at this many. */
export const MAX_MANUAL_SNAPSHOTS = 50;
export const SNAPSHOT_NAME_MAX = 200;
export const SNAPSHOT_DESCRIPTION_MAX = 2000;

export interface SnapshotStats {
  workItems: number;
  sprints: number;
  members: number;
}

export interface SnapshotMeta {
  id: string;
  name: string;
  description: string;
  kind: SnapshotKind;
  createdAt: Timestamp;
  createdBy: string;
  sizeBytes: number;
  stats: SnapshotStats;
}

export type SnapshotError =
  | { readonly code: 'SNAPSHOT_NOT_FOUND'; readonly id: string }
  | { readonly code: 'MANUAL_SNAPSHOT_LIMIT'; readonly max: number }
  | { readonly code: 'TEXT_TOO_LONG'; readonly field: 'name' | 'description'; readonly max: number };

export type SnapshotEvent =
  | { readonly type: 'SnapshotTaken'; readonly snapshotId: string; readonly kind: SnapshotKind; readonly occurredAt: Date }
  | { readonly type: 'SnapshotUpdated'; readonly snapshotId: string; readonly occurredAt: Date }
  | { readonly type: 'SnapshotDeleted'; readonly snapshotId: string; readonly occurredAt: Date }
  | { readonly type: 'ProjectReplaced'; readonly reason: Replacement['kind']; readonly safetySnapshotId: string; readonly occurredAt: Date };

/** Snapshot ids are file names, so anything but letters, digits, `_` and `-` can't be one. */
export function toSnapshotId(raw: string): Result<SnapshotId, SnapshotError> {
  return /^[\w-]+$/.test(raw) ? ok(raw as SnapshotId) : err({ code: 'SNAPSHOT_NOT_FOUND', id: raw });
}

/** Ids sort by the time they were taken: `2026-03-02T10-00-00-000Z-1a2b3c4d`. */
export function newSnapshotId(now: Date, unique: string): SnapshotId {
  const suffix = unique.replace(/[^\w-]/g, '').slice(0, 8);
  return `${now.toISOString().replace(/[:.]/g, '-')}-${suffix}` as SnapshotId;
}

export interface SnapshotDetailsInput {
  readonly name?: string | undefined;
  readonly description?: string | undefined;
}

/** A snapshot's name (trimmed) and description, checked. Either may be left out. */
export class SnapshotDetails {
  readonly name: string | undefined;
  readonly description: string | undefined;

  private constructor(name: string | undefined, description: string | undefined) {
    this.name = name;
    this.description = description;
    Object.freeze(this);
  }

  static validate(input: SnapshotDetailsInput): Result<SnapshotDetails, SnapshotError> {
    const name = input.name?.trim();
    if (name !== undefined && name.length > SNAPSHOT_NAME_MAX) return err({ code: 'TEXT_TOO_LONG', field: 'name', max: SNAPSHOT_NAME_MAX });
    const { description } = input;
    if (description !== undefined && description.length > SNAPSHOT_DESCRIPTION_MAX) {
      return err({ code: 'TEXT_TOO_LONG', field: 'description', max: SNAPSHOT_DESCRIPTION_MAX });
    }
    return ok(new SnapshotDetails(name, description));
  }
}

/** "Snapshot 2026-03-02 10:00 UTC", or "Automatic backup …" for scheduled ones. */
export function defaultSnapshotName(kind: SnapshotKind, now: Date): string {
  const stamp = now.toISOString().slice(0, 16).replace('T', ' ');
  return kind === 'auto' ? `Automatic backup ${stamp} UTC` : `Snapshot ${stamp} UTC`;
}

/** Why the whole project is about to be replaced. */
export type Replacement =
  | { readonly kind: 'restore'; readonly snapshotName: string }
  | { readonly kind: 'import' }
  | { readonly kind: 'reset'; readonly mode: 'empty' | 'demo' };

/** The safety snapshot taken before a replacement, so it can be undone. */
export function safetySnapshotFor(replacement: Replacement): { kind: SnapshotKind; name: string; description: string } {
  switch (replacement.kind) {
    case 'restore':
      return { kind: 'pre-restore', name: `Before restoring "${replacement.snapshotName}"`, description: 'Automatic safety snapshot taken before a restore' };
    case 'import':
      return { kind: 'pre-import', name: 'Before import', description: 'Automatic safety snapshot taken before importing a backup' };
    case 'reset':
      return {
        kind: 'pre-reset',
        name: 'Before reset',
        description: `Automatic safety snapshot taken before resetting to ${replacement.mode === 'demo' ? 'demo data' : 'an empty project'}`,
      };
  }
}

export interface NewSnapshot {
  readonly id: SnapshotId;
  readonly kind: SnapshotKind;
  /** An empty name gets the default one. */
  readonly name: string;
  readonly description: string;
  readonly createdBy: string;
  readonly stats: SnapshotStats;
  readonly sizeBytes: number | (() => number);
  readonly now: Date;
}

/** One snapshot's details. The copy of the project it holds is kept by the repository. */
export class Snapshot {
  readonly #props: SnapshotMeta;
  #events: SnapshotEvent[] = [];

  private constructor(props: SnapshotMeta) {
    this.#props = props;
  }

  /** A new snapshot. Taking one by hand is refused once there are `MAX_MANUAL_SNAPSHOTS` of them. */
  static take(input: NewSnapshot, existing: readonly Snapshot[]): Result<Snapshot, SnapshotError> {
    if (input.kind === 'manual' && existing.filter((s) => s.kind === 'manual').length >= MAX_MANUAL_SNAPSHOTS) {
      return err({ code: 'MANUAL_SNAPSHOT_LIMIT', max: MAX_MANUAL_SNAPSHOTS });
    }
    const snapshot = new Snapshot({
      id: input.id,
      name: input.name || defaultSnapshotName(input.kind, input.now),
      description: input.description,
      kind: input.kind,
      createdAt: input.now.toISOString(),
      createdBy: input.createdBy,
      sizeBytes: typeof input.sizeBytes === 'function' ? input.sizeBytes() : input.sizeBytes,
      stats: { ...input.stats },
    });
    snapshot.#events.push({ type: 'SnapshotTaken', snapshotId: input.id, kind: input.kind, occurredAt: input.now });
    return ok(snapshot);
  }

  /** Rebuild from stored details. Throws only if they are corrupt. */
  static reconstitute(meta: SnapshotMeta): Snapshot {
    if (!toSnapshotId(meta.id).ok) throw new Error(`Stored snapshot has an invalid id: ${meta.id}`);
    return new Snapshot({ ...meta, stats: { ...meta.stats } });
  }

  get id(): SnapshotId {
    return this.#props.id as SnapshotId;
  }
  get kind(): SnapshotKind {
    return this.#props.kind;
  }
  get name(): string {
    return this.#props.name;
  }
  get createdAt(): Date {
    return new Date(this.#props.createdAt);
  }

  update(details: SnapshotDetails, now: Date): void {
    if (details.name !== undefined) this.#props.name = details.name;
    if (details.description !== undefined) this.#props.description = details.description;
    this.#events.push({ type: 'SnapshotUpdated', snapshotId: this.#props.id, occurredAt: now });
  }

  remove(now: Date): void {
    this.#events.push({ type: 'SnapshotDeleted', snapshotId: this.#props.id, occurredAt: now });
  }

  pullEvents(): readonly SnapshotEvent[] {
    const events = this.#events;
    this.#events = [];
    return events;
  }

  toMeta(): SnapshotMeta {
    return { ...this.#props, stats: { ...this.#props.stats } };
  }
}

/** Newest first. */
export function newestFirst(snapshots: readonly Snapshot[]): Snapshot[] {
  return [...snapshots].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

/** Whether a scheduled snapshot is due: turned on, and none taken in the last `intervalHours`. */
export function scheduledSnapshotDue(settings: BackupSettings, snapshots: readonly Snapshot[], now: Date): boolean {
  if (!settings.autoEnabled) return false;
  const last = newestFirst(snapshots).find((s) => s.kind === 'auto');
  return !last || now.getTime() - last.createdAt.getTime() >= settings.intervalHours * 3_600_000;
}

/** Automatic snapshots beyond the newest `retain`, to delete. Others are never pruned. */
export function snapshotsToPrune(snapshots: readonly Snapshot[], retain: number): Snapshot[] {
  return newestFirst(snapshots)
    .filter((s) => s.kind === 'auto')
    .slice(retain);
}

/** The settings a reset to an empty project keeps. */
export function settingsKeptOnReset(settings: Settings): Settings {
  return {
    projectName: settings.projectName,
    teamName: settings.teamName,
    backup: { ...settings.backup },
    workingDays: [...settings.workingDays],
    areaPaths: [...settings.areaPaths],
  };
}

/** `fabrikam-backup-2026-03-02-10-00-00.json` */
export function backupFileName(projectName: string, now: Date): string {
  const stamp = now.toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const slug = projectName.replace(/[^\w-]+/g, '-').toLowerCase();
  return `${slug}-backup-${stamp}.json`;
}
