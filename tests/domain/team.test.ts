import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ProjectSettings, SettingsChanges, type SettingsInput } from '#domain/settings/project-settings.ts';
import { Member, MemberChanges, type MemberId, type MemberInput } from '#domain/team/member.ts';
import { LATER, NOW } from './fixtures.ts';

function changes(input: MemberInput): MemberChanges {
  const r = MemberChanges.validate(input);
  assert.ok(r.ok, JSON.stringify(r));
  return r.value;
}

function member(id: string, input: MemberInput, existing: Member[] = []): Member {
  const r = Member.create(changes(input), { id: id as MemberId, existing, now: NOW });
  assert.ok(r.ok, JSON.stringify(r));
  return r.value;
}

describe('team members', () => {
  it('get defaults and a colour in turn', () => {
    const ann = member('m1', { name: ' Ann ', username: ' ann.lee ' });
    assert.deepEqual(ann.toSnapshot(), { id: 'm1', name: 'Ann', username: 'ann.lee', email: '', color: '#0078d4', active: true });
    assert.equal(member('m2', { name: 'Bo' }, [ann]).toSnapshot().color, '#8764b8');
    assert.deepEqual(ann.pullEvents(), [{ type: 'MemberAdded', memberId: 'm1', occurredAt: NOW }]);
  });

  it('check names, usernames, emails and colours', () => {
    assert.deepEqual(MemberChanges.validate({ name: ' ' }), { ok: false, error: { code: 'MEMBER_NAME_REQUIRED' } });
    assert.deepEqual(MemberChanges.validate({ username: 'has space' }), { ok: false, error: { code: 'USERNAME_INVALID' } });
    assert.deepEqual(MemberChanges.validate({ username: 'x'.repeat(65) }), { ok: false, error: { code: 'TEXT_TOO_LONG', field: 'username', max: 64 } });
    assert.deepEqual(MemberChanges.validate({ email: 'x'.repeat(257) }), { ok: false, error: { code: 'TEXT_TOO_LONG', field: 'email', max: 256 } });
    assert.deepEqual(MemberChanges.validate({ color: 'red' }), { ok: false, error: { code: 'INVALID_COLOR' } });
    assert.deepEqual(Member.create(changes({ email: 'a@b.c' }), { id: 'm' as MemberId, existing: [], now: NOW }), { ok: false, error: { code: 'MEMBER_NAME_REQUIRED' } });
  });

  it('keep usernames unique, ignoring case, but allow many blank ones', () => {
    const ann = member('m1', { name: 'Ann', username: 'ann.lee' });
    const bo = member('m2', { name: 'Bo' }, [ann]);
    assert.deepEqual(Member.create(changes({ name: 'Other', username: 'ANN.LEE' }), { id: 'm3' as MemberId, existing: [ann, bo], now: NOW }), {
      ok: false,
      error: { code: 'USERNAME_TAKEN', username: 'ANN.LEE', takenBy: 'Ann' },
    });
    assert.deepEqual(bo.update(changes({ username: 'Ann.Lee' }), [ann, bo], LATER), {
      ok: false,
      error: { code: 'USERNAME_TAKEN', username: 'Ann.Lee', takenBy: 'Ann' },
    });
    assert.ok(ann.update(changes({ name: 'Ann Lee', username: 'ann.lee' }), [ann, bo], LATER).ok);
    assert.ok(member('m4', { name: 'Cy', username: '' }, [ann, bo]));
    assert.equal(ann.removalNote, 'Ann Lee was removed from the team');
  });
});

describe('project settings', () => {
  const settings = () =>
    ProjectSettings.reconstitute({
      projectName: 'Fabrikam',
      teamName: 'Team',
      workingDays: [1, 2, 3, 4, 5],
      areaPaths: ['Fabrikam'],
      backup: { autoEnabled: true, intervalHours: 24, retain: 14 },
    });
  const valid = (input: SettingsInput) => {
    const r = SettingsChanges.validate(input);
    assert.ok(r.ok, JSON.stringify(r));
    return r.value;
  };

  it('normalise names, working days and area paths', () => {
    const s = settings();
    s.update(valid({ projectName: ' Contoso ', workingDays: [5, 1, 1, 0], areaPaths: [' Contoso\\Web '] }), NOW);
    const snap = s.toSnapshot();
    assert.deepEqual([snap.projectName, snap.workingDays, snap.areaPaths], ['Contoso', [0, 1, 5], ['Contoso\\Web']]);
    assert.equal(s.defaultAreaPath, 'Contoso\\Web');
    assert.deepEqual(s.pullEvents(), [{ type: 'SettingsChanged', fields: ['projectName', 'workingDays', 'areaPaths'], occurredAt: NOW }]);
  });

  it('refuse values out of range', () => {
    assert.deepEqual(SettingsChanges.validate({ teamName: ' ' }), { ok: false, error: { code: 'SETTING_REQUIRED', field: 'teamName' } });
    assert.deepEqual(SettingsChanges.validate({ workingDays: [] }), { ok: false, error: { code: 'SETTING_REQUIRED', field: 'workingDays' } });
    assert.deepEqual(SettingsChanges.validate({ workingDays: [7] }), { ok: false, error: { code: 'NUMBER_OUT_OF_RANGE', field: 'workingDays', min: 0, max: 6 } });
    assert.deepEqual(SettingsChanges.validate({ areaPaths: [] }), { ok: false, error: { code: 'SETTING_REQUIRED', field: 'areaPaths' } });
    assert.deepEqual(SettingsChanges.validate({ backup: { autoEnabled: true, intervalHours: 0.5, retain: 3 } }), {
      ok: false,
      error: { code: 'NUMBER_OUT_OF_RANGE', field: 'intervalHours', min: 1, max: 720 },
    });
    assert.deepEqual(SettingsChanges.validate({ backup: { autoEnabled: true, intervalHours: 2, retain: 1.5 } }), { ok: false, error: { code: 'NOT_AN_INTEGER', field: 'retain' } });
  });

  it('fall back to the project name for the default area path', () => {
    const s = settings();
    s.update(valid({}), NOW);
    assert.equal(ProjectSettings.reconstitute({ ...s.toSnapshot(), areaPaths: [] }).defaultAreaPath, 'Fabrikam');
  });
});
