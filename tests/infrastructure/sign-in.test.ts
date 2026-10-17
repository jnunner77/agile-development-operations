import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { ApiToken, ApiTokenDraft } from '#domain/api-tokens/api-token.ts';
import { Account } from '#domain/sign-in/account.ts';
import { FileApiTokenRepository } from '#infrastructure/api-tokens/token-file.ts';
import { emptyDatabase } from '#infrastructure/json-store/schema.ts';
import { RejectedChangeError, Store } from '#infrastructure/json-store/store.ts';
import { StoreTeamDirectory } from '#infrastructure/json-store/team-directory.ts';
import { guardUsableAdmin } from '#infrastructure/sign-in/admin-guard.ts';
import { AuthFile, FileAccountRepository, FileSignInSettingsRepository } from '#infrastructure/sign-in/auth-file.ts';
import { RandomSecrets } from '#infrastructure/sign-in/random-secrets.ts';
import { ScryptHasher } from '#infrastructure/sign-in/scrypt-hasher.ts';

const NOW = new Date('2026-03-02T10:00:00.000Z');
let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boards-signin-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const mode = (file: string) => fs.statSync(path.join(dir, file)).mode & 0o777;

describe('auth.json', () => {
  it('keeps the existing format, readable by the server only', async () => {
    const file = new AuthFile(dir);
    assert.deepEqual(file.settings, { enabled: false, passwordExpiryDays: 60, sessionTimeoutMinutes: 60 });
    const accounts = new FileAccountRepository(file);
    const account = await accounts.get('m1');
    account.setAdmin(true, NOW);
    account.setPassword('scrypt$hash', NOW, false);
    await accounts.save(account);
    const stored = JSON.parse(fs.readFileSync(path.join(dir, 'auth.json'), 'utf8'));
    assert.deepEqual(stored, {
      settings: { enabled: false, passwordExpiryDays: 60, sessionTimeoutMinutes: 60 },
      accounts: { m1: { isAdmin: true, passwordHash: 'scrypt$hash', passwordSetAt: NOW.toISOString(), mustChange: false } },
    });
    assert.equal(mode('auth.json'), 0o600);
  });

  it('reads back what it wrote, filling in missing settings', async () => {
    fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ settings: { enabled: true }, accounts: { m1: { isAdmin: true, passwordHash: 'h', passwordSetAt: null, mustChange: true } } }));
    const file = new AuthFile(dir);
    const settings = await new FileSignInSettingsRepository(file).get();
    assert.deepEqual(settings.toSnapshot(), { enabled: true, passwordExpiryDays: 60, sessionTimeoutMinutes: 60 });
    const account = await new FileAccountRepository(file).get('m1');
    assert.deepEqual([account.isAdmin, account.mustChange, account.hasPassword], [true, true, true]);
    assert.equal((await new FileAccountRepository(file).get('nobody')).hasPassword, false);
  });
});

describe('api-tokens.json', () => {
  const token = (id: string) => {
    const draft = ApiTokenDraft.of({ name: id });
    assert.ok(draft.ok);
    return ApiToken.create(draft.value, { id, memberId: 'm1', secret: `boards_${id}_the_secret_part`, digest: `digest-${id}`, createdBy: 'Ann', now: NOW });
  };

  it('stores digests, never secrets, readable by the server only', async () => {
    const repo = new FileApiTokenRepository(dir, () => NOW.getTime());
    await repo.save(token('t1'));
    const raw = fs.readFileSync(path.join(dir, 'api-tokens.json'), 'utf8');
    assert.equal(raw.includes('the_secret_part'), false);
    assert.equal(JSON.parse(raw).tokens[0].hash, 'digest-t1');
    assert.equal(mode('api-tokens.json'), 0o600);
    assert.equal((await new FileApiTokenRepository(dir).findByDigest('digest-t1'))?.id, 't1');
    assert.equal(await repo.findByDigest('digest-other'), undefined);
  });

  it('writes a token’s last use at most once a minute', async () => {
    let now = NOW.getTime();
    const repo = new FileApiTokenRepository(dir, () => now);
    const t = token('t1');
    await repo.save(t);
    const lastUsed = () => JSON.parse(fs.readFileSync(path.join(dir, 'api-tokens.json'), 'utf8')).tokens[0].lastUsedAt;
    t.recordUse(new Date(now));
    await repo.saveUse(t);
    assert.equal(lastUsed(), new Date(now).toISOString());
    now += 1000;
    t.recordUse(new Date(now));
    await repo.saveUse(t);
    assert.equal(lastUsed(), new Date(now - 1000).toISOString());
    assert.equal((await repo.findById('t1'))?.toInfo(NOW).lastUsedAt, new Date(now).toISOString());
    now += 60_000;
    await repo.saveUse(t);
    assert.equal(lastUsed(), new Date(now - 60_000).toISOString());
    await repo.delete('t1');
    assert.deepEqual(await repo.all(), []);
  });
});

describe('secrets and hashing', () => {
  it('hash passwords with scrypt and a salt, verifying only the right one', async () => {
    const hasher = new ScryptHasher();
    const hash = await hasher.hash('correct horse');
    assert.match(hash, /^scrypt\$16384\$8\$1\$/);
    assert.notEqual(await hasher.hash('correct horse'), hash);
    assert.equal(await hasher.verify('correct horse', hash), true);
    assert.equal(await hasher.verify('wrong', hash), false);
    assert.equal(await hasher.verify('x', 'not a hash'), false);
    await hasher.verifyNothing('anything');
  });

  it('make long random tokens and SHA-256 digests', () => {
    const secrets = new RandomSecrets();
    assert.match(secrets.newApiToken(), /^boards_[\w-]{43}$/);
    assert.notEqual(secrets.newSessionToken(), secrets.newSessionToken());
    assert.equal(secrets.digest('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('keeping an administrator', () => {
  it('refuses a database without one while sign-in is on', async () => {
    const store = new Store(dir, () => emptyDatabase());
    store.transact('Ann', undefined, (tx) => {
      tx.db.members.push({ id: 'm1', name: 'Ann', username: 'ann', email: '', color: '#000000', active: true });
    });
    const file = new AuthFile(dir);
    const account = Account.blank('m1');
    account.setAdmin(true, NOW);
    account.setPassword('h', NOW, false);
    file.saveAccount(account);
    file.saveSettings({ ...file.settings, enabled: true });
    guardUsableAdmin(store, file, false);
    assert.throws(() => store.replace(emptyDatabase()), RejectedChangeError);
    assert.equal(store.db.members.length, 1);
    // Forced off, the guard steps aside so an administrator can recover.
    const forced = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'boards-forced-')), () => emptyDatabase());
    guardUsableAdmin(forced, file, true);
    assert.doesNotThrow(() => forced.replace(emptyDatabase()));
    assert.deepEqual((await new StoreTeamDirectory(store).all()).map((m) => m.id), ['m1']);
    assert.equal(await new StoreTeamDirectory(store).findById('nope'), undefined);
  });
});
