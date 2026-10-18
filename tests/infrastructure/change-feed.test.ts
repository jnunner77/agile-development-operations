import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { Delta } from '#application/contracts/database.ts';
import { StoreChangeFeed } from '#infrastructure/json-store/store-change-feed.ts';
import { emptyDatabase } from '#infrastructure/json-store/schema.ts';
import { Store } from '#infrastructure/json-store/store.ts';

describe('the change feed over the store', () => {
  it('passes on every commit with the tab it came from, until unsubscribed', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boards-feed-'));
    try {
      const store = new Store(dir, () => emptyDatabase());
      const seen: [Delta, string | undefined][] = [];
      const stop = new StoreChangeFeed(store).subscribe((delta, origin) => seen.push([delta, origin]));
      store.transact('Ann', 'tab-1', (tx) => {
        tx.db.settings.teamName = 'Renamed';
        tx.settings = true;
      });
      stop();
      store.transact('Ann', undefined, () => undefined);
      assert.equal(seen.length, 1);
      assert.equal(seen[0]?.[1], 'tab-1');
      assert.equal(seen[0]?.[0].settings?.teamName, 'Renamed');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
