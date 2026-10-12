import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { blankWorkItem, emptyDatabase } from '../server/schema';
import { Store } from '../server/store';

let dir: string;
let store: Store;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boards-store-'));
  store = new Store(dir, () => emptyDatabase());
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Make the next write of the database fail, as on a full disk. */
function failNextWrite() {
  vi.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => {
    throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
  });
}

const onDisk = () => JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8'));
const addTask = (title: string) =>
  store.transact('Ann', undefined, (tx) => {
    tx.db.workItems.push(blankWorkItem({ id: tx.db.nextWorkItemId++, type: 'Task', title }));
  });

describe('store', () => {
  it('leaves the live database, its version and browsers alone when a change cannot be saved', () => {
    addTask('Saved');
    const version = store.db.version;
    const sent = vi.fn();
    store.subscribe(sent);

    failNextWrite();
    expect(() => addTask('Lost')).toThrow(/ENOSPC/);
    expect(store.db.version).toBe(version);
    expect(store.db.workItems.map((w) => w.title)).toEqual(['Saved']);
    expect(onDisk().workItems.map((w: { title: string }) => w.title)).toEqual(['Saved']);
    expect(sent).not.toHaveBeenCalled();
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);

    // The next change works and is saved as usual.
    addTask('Later');
    expect(onDisk().workItems.map((w: { title: string }) => w.title)).toEqual(['Saved', 'Later']);
    expect(sent).toHaveBeenCalledTimes(1);
  });

  it('removes the half-written temp file when the final rename fails', () => {
    addTask('Saved');
    const version = store.db.version;
    const sent = vi.fn();
    store.subscribe(sent);
    vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('EIO: i/o error, rename'), { code: 'EIO' });
    });
    expect(() => addTask('Lost')).toThrow(/EIO/);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    expect(store.db.version).toBe(version);
    expect(onDisk().workItems).toHaveLength(1);
    expect(sent).not.toHaveBeenCalled();
  });

  it('leaves everything alone when a replacement cannot be saved', () => {
    addTask('Current');
    const version = store.db.version;
    const sent = vi.fn();
    store.subscribe(sent);

    failNextWrite();
    expect(() => store.replace(emptyDatabase())).toThrow(/ENOSPC/);
    expect(store.db.version).toBe(version);
    expect(store.db.workItems.map((w) => w.title)).toEqual(['Current']);
    expect(onDisk().workItems).toHaveLength(1);
    expect(sent).not.toHaveBeenCalled();
  });
});
