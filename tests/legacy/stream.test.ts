import { describe, expect, it } from 'vitest';
import { StreamVersion, loadFresh } from '../../client/src/lib/stream.ts';

describe('live-update stream version', () => {
  it('asks for a reload after a reconnect when others changed things while it was down', () => {
    const stream = new StreamVersion();
    stream.loaded(10);
    stream.received(11); // someone else's change, over the stream
    // The stream drops. Others make changes 12 and 13; ours is 14 and its response reaches the
    // page (bringing the page's own version to 14) but the stream never delivered 12 or 13.
    // On reconnect the server reports 14.
    expect(stream.missedChanges(14)).toBe(true);
    stream.loaded(14); // the reload
    expect(stream.missedChanges(14)).toBe(false);
  });

  it('does not reload when nothing was missed', () => {
    const stream = new StreamVersion();
    stream.loaded(10);
    expect(stream.missedChanges(10)).toBe(false); // first connection right after the load
    stream.received(11);
    stream.received(12); // our own change comes back over the stream too
    expect(stream.missedChanges(12)).toBe(false); // a reconnect with nothing new
  });

  it('fetches again when a full load is older than an update the page already applied', async () => {
    // The page asked for a full load at version 10; while it was in flight, update 11 arrived.
    let page = 10;
    const responses = [10, 11];
    const fetchDb = async () => {
      const version = responses.shift()!;
      page = 11; // applied while the first request was in flight
      return { version };
    };
    const db = await loadFresh(fetchDb, () => page);
    expect(db.version).toBe(11);
    expect(responses).toEqual([]);
  });

  it('uses the first load when it is current, and gives up retrying after a few tries', async () => {
    let calls = 0;
    expect((await loadFresh(async () => ({ version: ++calls + 4 }), () => 5)).version).toBe(5);
    expect(calls).toBe(1);
    // A server that restarted with fresh data is behind for good: take its copy after 3 tries.
    calls = 0;
    expect((await loadFresh(async () => ({ version: ++calls }), () => 50)).version).toBe(3);
    expect(calls).toBe(3);
  });
});
