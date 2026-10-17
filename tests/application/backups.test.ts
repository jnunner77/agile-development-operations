import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DeleteSnapshot } from '#application/backups/delete-snapshot.ts';
import { DownloadSnapshot } from '#application/backups/download-snapshot.ts';
import { ExportBackup } from '#application/backups/export-backup.ts';
import { ImportBackup } from '#application/backups/import-backup.ts';
import { ListSnapshots } from '#application/backups/list-snapshots.ts';
import { ResetProject } from '#application/backups/reset-project.ts';
import { RestoreSnapshot } from '#application/backups/restore-snapshot.ts';
import { TakeScheduledSnapshot } from '#application/backups/take-scheduled-snapshot.ts';
import { TakeSnapshot } from '#application/backups/take-snapshot.ts';
import { UpdateSnapshot } from '#application/backups/update-snapshot.ts';
import { SignInSettingsChanges } from '#domain/sign-in/settings.ts';
import { admin, ann, bo, NOW, setup, tokenCaller, unwrap } from './fixtures.ts';

const HOUR = 3_600_000;

const member = (id: string, name: string) => ({ id, name, username: id, email: '', color: '#0078d4', active: true });

describe('taking snapshots', () => {
  it('copies the whole project, and lists snapshots newest first', async () => {
    const t = setup();
    t.project.data.members = [member('m1', 'Ann')];
    const take = new TakeSnapshot(t.deps);
    const first = unwrap(await take.execute({ caller: bo, name: ' Baseline ' }));
    assert.equal(first.name, 'Baseline');
    assert.equal(first.createdBy, 'Bo');
    assert.equal(first.kind, 'manual');
    assert.deepEqual(first.stats, { workItems: 0, sprints: 0, members: 1 });
    assert.ok(first.sizeBytes > 0);
    t.clock.at += HOUR;
    const second = unwrap(await take.execute({ caller: bo }));
    assert.equal(second.name, 'Snapshot 2026-03-02 11:00 UTC');
    assert.deepEqual((await new ListSnapshots(t.deps).execute()).map((s) => s.id), [second.id, first.id]);
    assert.ok(t.published.some((e) => e.type === 'SnapshotTaken'));
  });

  it('refuses a name that is too long', async () => {
    const t = setup();
    assert.deepEqual(await new TakeSnapshot(t.deps).execute({ caller: bo, name: 'x'.repeat(201) }), { ok: false, error: { code: 'TEXT_TOO_LONG', field: 'name', max: 200 } });
  });
});

describe('managing snapshots', () => {
  it('is for administrators only, never API tokens', async () => {
    const t = setup();
    const { id } = unwrap(await new TakeSnapshot(t.deps).execute({ caller: bo }));
    for (const caller of [bo, tokenCaller]) {
      assert.equal((await new UpdateSnapshot(t.deps).execute({ caller, id, name: 'x' })).ok, false);
      assert.equal((await new DeleteSnapshot(t.deps).execute({ caller, id })).ok, false);
      assert.equal((await new RestoreSnapshot(t.deps).execute({ caller, id })).ok, false);
      assert.equal((await new ImportBackup(t.deps).execute({ caller, file: t.project.data })).ok, false);
      assert.equal((await new ResetProject(t.deps).execute({ caller, mode: 'empty' })).ok, false);
    }
    assert.equal(t.project.replaced.length, 0);
    assert.equal((await new ListSnapshots(t.deps).execute()).length, 1);
  });

  it('renames, describes and deletes them', async () => {
    const t = setup();
    const { id } = unwrap(await new TakeSnapshot(t.deps).execute({ caller: bo }));
    const renamed = unwrap(await new UpdateSnapshot(t.deps).execute({ caller: admin, id, name: 'Kept', description: 'Before go-live' }));
    assert.deepEqual([renamed.name, renamed.description], ['Kept', 'Before go-live']);
    unwrap(await new DeleteSnapshot(t.deps).execute({ caller: admin, id }));
    assert.deepEqual(await new ListSnapshots(t.deps).execute(), []);
    assert.deepEqual(await new DeleteSnapshot(t.deps).execute({ caller: admin, id }), { ok: false, error: { code: 'SNAPSHOT_NOT_FOUND', id } });
    assert.deepEqual(await new UpdateSnapshot(t.deps).execute({ caller: admin, id: '../db', name: 'x' }), { ok: false, error: { code: 'SNAPSHOT_NOT_FOUND', id: '../db' } });
  });

  it('downloads a snapshot file', async () => {
    const t = setup();
    const { id } = unwrap(await new TakeSnapshot(t.deps).execute({ caller: bo }));
    const download = unwrap(await new DownloadSnapshot(t.deps).execute({ id }));
    assert.equal(download.fileName, `snapshot-${id}.json`);
    assert.ok(download.contents.byteLength > 0);
    assert.deepEqual(await new DownloadSnapshot(t.deps).execute({ id: 'missing' }), { ok: false, error: { code: 'SNAPSHOT_NOT_FOUND', id: 'missing' } });
  });
});

describe('replacing the project', () => {
  it('restores a snapshot after taking a safety snapshot', async () => {
    const t = setup();
    t.project.data.members = [member('m1', 'Ann')];
    const { id } = unwrap(await new TakeSnapshot(t.deps).execute({ caller: bo, name: 'Baseline' }));
    t.project.data.members = [];
    t.clock.at += 1000;
    const { safetySnapshot } = unwrap(await new RestoreSnapshot(t.deps).execute({ caller: { ...admin, origin: 'tab-9' }, id }));
    assert.equal(safetySnapshot.kind, 'pre-restore');
    assert.equal(safetySnapshot.name, 'Before restoring "Baseline"');
    assert.equal(safetySnapshot.stats.members, 0);
    assert.deepEqual(t.project.data.members.map((m) => m.name), ['Ann']);
    assert.equal(t.project.replaced[0]?.origin, 'tab-9');
    assert.ok(t.published.some((e) => e.type === 'ProjectReplaced' && e.reason === 'restore' && e.safetySnapshotId === safetySnapshot.id));
    assert.equal((await new ListSnapshots(t.deps).execute()).length, 2);
  });

  it('imports a backup, or says what is wrong with it', async () => {
    const t = setup();
    const file = { ...t.project.data, members: [member('m5', 'Eve')] };
    assert.deepEqual(await new ImportBackup(t.deps).execute({ caller: admin, file: { nope: true } }), {
      ok: false,
      error: { code: 'INVALID_BACKUP', reason: 'Backup is missing the "workItems" list' },
    });
    assert.deepEqual(await new ListSnapshots(t.deps).execute(), []);
    const { safetySnapshot } = unwrap(await new ImportBackup(t.deps).execute({ caller: admin, file }));
    assert.equal(safetySnapshot.name, 'Before import');
    assert.deepEqual(t.project.data.members.map((m) => m.name), ['Eve']);
  });

  it('resets to an empty project that keeps the settings, or to the demo', async () => {
    const t = setup();
    t.project.data.members = [member('m1', 'Ann')];
    t.project.data.settings.teamName = 'Kept team';
    const empty = unwrap(await new ResetProject(t.deps).execute({ caller: admin, mode: 'empty' }));
    assert.equal(empty.safetySnapshot.description, 'Automatic safety snapshot taken before resetting to an empty project');
    assert.equal(t.project.data.members.length, 0);
    assert.equal(t.project.data.settings.teamName, 'Kept team');
    unwrap(await new ResetProject(t.deps).execute({ caller: admin, mode: 'demo' }));
    assert.deepEqual(t.project.data.members.map((m) => m.name), ['Dee']);
  });

  it('keeps an administrator who can sign in while sign-in is on', async () => {
    const t = setup();
    t.project.data.members = [member('m1', 'Ann')];
    const account = await t.accounts.get('m1');
    account.setAdmin(true, NOW);
    account.setPassword('hashed:correct horse', NOW, false);
    await t.accounts.save(account);
    const settings = await t.signInSettings.get();
    const on = SignInSettingsChanges.validate({ enabled: true });
    assert.ok(on.ok);
    assert.ok(settings.update(on.value, true, NOW).ok);
    await t.signInSettings.save(settings);

    // The demo's only member has no account, so nobody could sign in afterwards.
    assert.deepEqual(await new ResetProject(t.deps).execute({ caller: ann, mode: 'demo' }), { ok: false, error: { code: 'LAST_ADMIN' } });
    assert.deepEqual(await new ResetProject(t.deps).execute({ caller: ann, mode: 'empty' }), { ok: false, error: { code: 'LAST_ADMIN' } });
    assert.deepEqual(await new ListSnapshots(t.deps).execute(), []);
    assert.equal(t.project.replaced.length, 0);
    // A backup that keeps Ann is fine.
    assert.equal((await new ImportBackup(t.deps).execute({ caller: ann, file: t.project.data })).ok, true);
  });
});

describe('scheduled snapshots', () => {
  it('are taken when due and old ones pruned, leaving the rest alone', async () => {
    const t = setup();
    t.project.data.settings.backup = { autoEnabled: true, intervalHours: 1, retain: 2 };
    const scheduled = new TakeScheduledSnapshot(t.deps);
    const first = await scheduled.execute();
    assert.equal(first?.kind, 'auto');
    assert.equal(first?.createdBy, 'System');
    assert.equal(first?.name, 'Automatic backup 2026-03-02 10:00 UTC');
    assert.equal(first?.description, 'Scheduled automatic backup');
    t.clock.at += 1000;
    assert.equal(await scheduled.execute(), null);
    t.clock.at += HOUR;
    assert.ok(await scheduled.execute());
    unwrap(await new TakeSnapshot(t.deps).execute({ caller: bo, name: 'Manual' }));
    for (let i = 0; i < 2; i++) {
      t.clock.at += HOUR;
      assert.ok(await scheduled.execute());
    }
    const list = await new ListSnapshots(t.deps).execute();
    assert.equal(list.filter((s) => s.kind === 'auto').length, 2);
    assert.equal(list.filter((s) => s.kind === 'manual').length, 1);
    assert.ok(!list.some((s) => s.id === first?.id));
    assert.ok(t.published.some((e) => e.type === 'SnapshotDeleted' && e.snapshotId === first?.id));
    t.project.data.settings.backup.autoEnabled = false;
    t.clock.at += 99 * HOUR;
    assert.equal(await scheduled.execute(), null);
  });
});

describe('exporting', () => {
  it('names the file after the project and records who exported it', async () => {
    const t = setup();
    const exported = await new ExportBackup(t.deps).execute({ caller: bo });
    assert.equal(exported.fileName, 'fabrikam-backup-2026-03-02-10-00-00.json');
    assert.equal(exported.file.format, 'ado-clone-backup');
    assert.equal(exported.file.exportedBy, 'Bo');
    assert.equal(exported.file.exportedAt, NOW.toISOString());
    assert.equal(exported.file.data.settings.projectName, 'Fabrikam');
  });
});
