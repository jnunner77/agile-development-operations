import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { callerFor } from '#application/caller.ts';
import { LoadProject } from '#application/project/load-project.ts';
import { WatchChanges } from '#application/project/watch-changes.ts';
import type { Identity } from '#application/sign-in/identity.ts';
import type { Delta } from '#application/contracts/database.ts';
import { NOW, setup } from './fixtures.ts';

const member = (id: string, name: string) => ({ id, name, username: id, email: '', color: '#0078d4', active: true });
const team = [member('m1', 'Ann'), member('m2', 'Bo'), member('m3', 'Twin'), member('m4', 'Twin')];
const nobody: Identity = { signInEnabled: false, member: null, isAdmin: false, via: 'none', token: null, invalidToken: false };

describe('the caller', () => {
  it('acts as the member the browser names, by id or by a name only one member has', () => {
    assert.deepEqual(callerFor({ identity: nobody, actingAs: 'm2', team, origin: 'tab-1' }), {
      name: 'Bo',
      memberId: 'm2',
      mayModerateComments: true,
      admin: 'granted',
      origin: 'tab-1',
    });
    assert.equal(callerFor({ identity: nobody, actingAs: 'Ann', team, origin: undefined }).memberId, 'm1');
    const twin = callerFor({ identity: nobody, actingAs: 'Twin', team, origin: undefined });
    assert.deepEqual([twin.name, twin.memberId], ['Twin', null]);
    const stranger = callerFor({ identity: nobody, actingAs: 'x'.repeat(300), team, origin: undefined });
    assert.deepEqual([stranger.name.length, stranger.memberId], [128, null]);
    assert.deepEqual(callerFor({ identity: nobody, actingAs: null, team, origin: undefined }).name, 'Anonymous');
  });

  it('is the signed-in member, with the rights sign-in gives', () => {
    const signedIn: Identity = { ...nobody, signInEnabled: true, member: member('m2', 'Bo'), via: 'session' };
    const caller = callerFor({ identity: signedIn, actingAs: 'm2', team, origin: undefined });
    assert.deepEqual([caller.name, caller.memberId, caller.admin, caller.mayModerateComments], ['Bo', 'm2', 'not-admin', false]);
    const token = callerFor({ identity: { ...signedIn, via: 'token' }, actingAs: 'm2', team, origin: undefined });
    assert.equal(token.admin, 'token');
  });
});

describe('the project for browsers', () => {
  it('loads with the server time', async () => {
    const t = setup();
    const loaded = await new LoadProject(t.deps).execute();
    assert.equal(loaded.db.settings.projectName, 'Fabrikam');
    assert.equal(loaded.serverTime, NOW.toISOString());
  });

  it('follows committed changes until told to stop', () => {
    const t = setup();
    const seen: [Delta, string | undefined][] = [];
    const watching = new WatchChanges(t.deps).execute((delta, origin) => seen.push([delta, origin]));
    assert.equal(watching.version, t.project.data.version);
    t.changes.emit({ version: 2 }, 'tab-1');
    watching.stop();
    t.changes.emit({ version: 3 });
    assert.deepEqual(seen, [[{ version: 2 }, 'tab-1']]);
    assert.equal(t.changes.listening, 0);
  });
});
