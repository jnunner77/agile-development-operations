import { Snapshot, newSnapshotId, safetySnapshotFor, snapshotsToPrune, type Replacement, type SnapshotError, type SnapshotKind, type SnapshotMeta } from '#domain/snapshots/snapshot.ts';
import type { DomainEvent } from '#domain/events.ts';
import { ok, type Result } from '#shared/result.ts';
import type { AccessError } from '../access.ts';
import type { Caller } from '../caller.ts';
import type { Database } from '../contracts/database.ts';
import type { AppDeps } from '../deps.ts';
import { checkAdminKept, type LastAdminError } from '../team/deps.ts';
import type { BackupError, ProjectCopy } from './ports.ts';

export type BackupDeps = Pick<AppDeps, 'snapshots' | 'project' | 'accounts' | 'signInSettings' | 'signInForcedOff' | 'clock' | 'ids' | 'events'>;

/** Every error a snapshot or backup use case can return. */
export type BackupsError = SnapshotError | BackupError | AccessError | LastAdminError;

/** What a restore, import or reset answers: the snapshot that undoes it. */
export interface Replaced {
  readonly safetySnapshot: SnapshotMeta;
}

const statsOf = (data: Database) => ({ workItems: data.workItems.length, sprints: data.sprints.length, members: data.members.length });

/**
 * Take a snapshot of the project as it is now. Taking an automatic one also deletes automatic
 * ones beyond the number to keep. Call it inside `project.exclusive`.
 */
export async function takeSnapshot(
  deps: BackupDeps,
  input: { readonly kind: SnapshotKind; readonly name: string; readonly description: string; readonly createdBy: string },
): Promise<Result<Snapshot, SnapshotError>> {
  const now = deps.clock.now();
  const copy: ProjectCopy = deps.project.capture();
  const existing = await deps.snapshots.all();
  const taken = Snapshot.take({ ...input, id: newSnapshotId(now, deps.ids.next()), stats: statsOf(copy.data), sizeBytes: copy.sizeBytes, now }, existing);
  if (!taken.ok) return taken;
  await deps.snapshots.add(taken.value, copy);
  const events: DomainEvent[] = [...taken.value.pullEvents()];
  if (input.kind === 'auto') {
    for (const old of snapshotsToPrune([taken.value, ...existing], copy.data.settings.backup.retain)) {
      await deps.snapshots.delete(old.id);
      old.remove(now);
      events.push(...old.pullEvents());
    }
  }
  await deps.events.publish(events);
  return taken;
}

/**
 * Replace the whole project, after taking a safety snapshot so it can be undone. With sign-in on,
 * the new project must keep an administrator who can sign in. Call it inside `project.exclusive`.
 */
export async function replaceProject(
  deps: BackupDeps,
  caller: Caller,
  data: Database,
  replacement: Replacement,
): Promise<Result<Replaced, SnapshotError | LastAdminError>> {
  const kept = await checkAdminKept(deps, data.members);
  if (!kept.ok) return kept;
  const safety = await takeSnapshot(deps, { ...safetySnapshotFor(replacement), createdBy: caller.name });
  if (!safety.ok) return safety;
  deps.project.replace(data, caller.origin);
  await deps.events.publish([{ type: 'ProjectReplaced', reason: replacement.kind, safetySnapshotId: safety.value.id, occurredAt: deps.clock.now() }]);
  return ok({ safetySnapshot: safety.value.toMeta() });
}
