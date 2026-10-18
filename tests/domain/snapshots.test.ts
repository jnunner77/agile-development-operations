import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MAX_MANUAL_SNAPSHOTS,
  Snapshot,
  SnapshotDetails,
  backupFileName,
  defaultSnapshotName,
  newSnapshotId,
  safetySnapshotFor,
  scheduledSnapshotDue,
  settingsKeptOnReset,
  snapshotsToPrune,
  toSnapshotId,
  type NewSnapshot,
  type SnapshotKind,
} from '#domain/snapshots/snapshot.ts';
import { NOW } from './fixtures.ts';

const HOUR = 3_600_000;
const stats = { workItems: 3, sprints: 1, members: 2 };

function snapshot(kind: SnapshotKind, at: Date, fields: Partial<NewSnapshot> = {}, existing: Snapshot[] = []): Snapshot {
  const result = Snapshot.take({ id: newSnapshotId(at, `${kind}${at.getTime()}`), kind, name: '', description: '', createdBy: 'Ann', stats, sizeBytes: 10, now: at, ...fields }, existing);
  assert.ok(result.ok, JSON.stringify(result));
  return result.value;
}

describe('snapshot ids', () => {
  it('sort by when they were taken and are safe file names', () => {
    assert.equal(newSnapshotId(NOW, 'a1b2c3d4-e5f6'), '2026-03-02T10-00-00-000Z-a1b2c3d4');
    assert.equal(newSnapshotId(NOW, '../x'), '2026-03-02T10-00-00-000Z-x');
    assert.equal(toSnapshotId('2026-03-02T10-00-00-000Z-a1b2c3d4').ok, true);
    for (const bad of ['../db', 'a b', '', 'x.json']) assert.deepEqual(toSnapshotId(bad), { ok: false, error: { code: 'SNAPSHOT_NOT_FOUND', id: bad } });
  });
});

describe('snapshot details', () => {
  it('trims the name and checks lengths', () => {
    const details = SnapshotDetails.validate({ name: '  Baseline  ', description: ' as typed ' });
    assert.ok(details.ok);
    assert.equal(details.value.name, 'Baseline');
    assert.equal(details.value.description, ' as typed ');
    assert.deepEqual(SnapshotDetails.validate({ name: 'x'.repeat(201) }), { ok: false, error: { code: 'TEXT_TOO_LONG', field: 'name', max: 200 } });
    assert.deepEqual(SnapshotDetails.validate({ description: 'x'.repeat(2001) }), { ok: false, error: { code: 'TEXT_TOO_LONG', field: 'description', max: 2000 } });
    const none = SnapshotDetails.validate({});
    assert.ok(none.ok);
    assert.equal(none.value.name, undefined);
  });

  it('names unnamed snapshots after when they were taken', () => {
    assert.equal(defaultSnapshotName('manual', NOW), 'Snapshot 2026-03-02 10:00 UTC');
    assert.equal(defaultSnapshotName('auto', NOW), 'Automatic backup 2026-03-02 10:00 UTC');
    assert.equal(snapshot('manual', NOW).toMeta().name, 'Snapshot 2026-03-02 10:00 UTC');
    assert.equal(snapshot('manual', NOW, { name: 'Baseline' }).toMeta().name, 'Baseline');
  });

  it('describes the safety snapshot taken before each kind of replacement', () => {
    assert.deepEqual(safetySnapshotFor({ kind: 'restore', snapshotName: 'Baseline' }), {
      kind: 'pre-restore',
      name: 'Before restoring "Baseline"',
      description: 'Automatic safety snapshot taken before a restore',
    });
    assert.equal(safetySnapshotFor({ kind: 'import' }).kind, 'pre-import');
    assert.equal(safetySnapshotFor({ kind: 'reset', mode: 'demo' }).description, 'Automatic safety snapshot taken before resetting to demo data');
    assert.equal(safetySnapshotFor({ kind: 'reset', mode: 'empty' }).description, 'Automatic safety snapshot taken before resetting to an empty project');
  });
});

describe('taking snapshots', () => {
  it('records who took it, when, and how much it holds', () => {
    const taken = snapshot('manual', NOW, { name: 'Baseline', description: 'Before the demo' });
    assert.deepEqual(taken.toMeta(), {
      id: newSnapshotId(NOW, `manual${NOW.getTime()}`),
      name: 'Baseline',
      description: 'Before the demo',
      kind: 'manual',
      createdAt: NOW.toISOString(),
      createdBy: 'Ann',
      sizeBytes: 10,
      stats,
    });
    assert.deepEqual(taken.pullEvents().map((e) => e.type), ['SnapshotTaken']);
  });

  it('caps snapshots taken by hand, but never automatic or safety ones', () => {
    const existing = Array.from({ length: MAX_MANUAL_SNAPSHOTS }, (_, i) => snapshot('manual', new Date(NOW.getTime() + i)));
    const input: NewSnapshot = { id: newSnapshotId(NOW, 'x'), kind: 'manual', name: '', description: '', createdBy: 'Ann', stats, sizeBytes: 1, now: NOW };
    assert.deepEqual(Snapshot.take(input, existing), { ok: false, error: { code: 'MANUAL_SNAPSHOT_LIMIT', max: 50 } });
    for (const kind of ['auto', 'pre-restore', 'pre-import', 'pre-reset'] as const) assert.equal(Snapshot.take({ ...input, kind }, existing).ok, true);
  });

  it('does not calculate snapshot size when the manual cap is reached', () => {
    const existing = Array.from({ length: MAX_MANUAL_SNAPSHOTS }, (_, i) => snapshot('manual', new Date(NOW.getTime() + i)));
    let reads = 0;
    const input: NewSnapshot = {
      id: newSnapshotId(NOW, 'x'),
      kind: 'manual',
      name: '',
      description: '',
      createdBy: 'Ann',
      stats,
      sizeBytes: () => (reads++, 1),
      now: NOW,
    };
    assert.equal(Snapshot.take(input, existing).ok, false);
    assert.equal(reads, 0);
  });

  it('can be renamed and described, and never shares its stats', () => {
    const taken = snapshot('manual', NOW, { name: 'Old' });
    const details = SnapshotDetails.validate({ name: 'New' });
    assert.ok(details.ok);
    taken.update(details.value, NOW);
    taken.toMeta().stats.workItems = 99;
    assert.equal(taken.toMeta().name, 'New');
    assert.equal(taken.toMeta().stats.workItems, 3);
  });
});

describe('the backup schedule', () => {
  const settings = { autoEnabled: true, intervalHours: 1, retain: 2 };

  it('is due when none was taken within the interval, and only while turned on', () => {
    assert.equal(scheduledSnapshotDue(settings, [], NOW), true);
    const recent = [snapshot('auto', NOW), snapshot('manual', new Date(NOW.getTime() + 2 * HOUR))];
    assert.equal(scheduledSnapshotDue(settings, recent, new Date(NOW.getTime() + 1000)), false);
    assert.equal(scheduledSnapshotDue(settings, recent, new Date(NOW.getTime() + HOUR)), true);
    assert.equal(scheduledSnapshotDue({ ...settings, autoEnabled: false }, [], NOW), false);
  });

  it('prunes automatic snapshots beyond the number to keep, oldest first', () => {
    const at = (h: number) => new Date(NOW.getTime() + h * HOUR);
    const all = [snapshot('auto', at(0)), snapshot('manual', at(1)), snapshot('auto', at(2)), snapshot('auto', at(3)), snapshot('pre-reset', at(4))];
    assert.deepEqual(snapshotsToPrune(all, 2).map((s) => s.createdAt.toISOString()), [at(0).toISOString()]);
    assert.deepEqual(snapshotsToPrune(all, 0).length, 3);
  });
});

describe('resets and exports', () => {
  it('keeps the project settings, as copies', () => {
    const settings = { projectName: 'P', teamName: 'T', workingDays: [1, 2], areaPaths: ['P'], backup: { autoEnabled: false, intervalHours: 6, retain: 3 } };
    const kept = settingsKeptOnReset(settings);
    assert.deepEqual(kept, settings);
    kept.areaPaths.push('Q');
    assert.deepEqual(settings.areaPaths, ['P']);
  });

  it('names backup files after the project and the time', () => {
    assert.equal(backupFileName('Fabrikam Web/App', NOW), 'fabrikam-web-app-backup-2026-03-02-10-00-00.json');
  });
});
