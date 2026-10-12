import { describe, expect, it } from 'vitest';
import { StreamVersion } from '../client/src/lib/stream';

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
});
