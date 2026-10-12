import { describe, expect, it } from 'vitest';
import { applyDelta, setDatabase, useStore } from '../client/src/store';
import { blankWorkItem, emptyDatabase } from '../server/schema';

const item = (title: string) => blankWorkItem({ id: 1, type: 'Task', title });
const title = () => useStore.getState().workItems.find((w) => w.id === 1)?.title;

describe('client store', () => {
  it('ignores a live update that is no newer than the last full load', () => {
    // The page loads everything at version 12, which already has the item renamed at 12.
    setDatabase({ ...emptyDatabase(), version: 12, workItems: [item('Renamed at 12')] });
    // The response to an older change (version 11) arrives late: it must not put the old title back.
    expect(applyDelta({ version: 11, workItems: [item('Old title from 11')] })).toBe(false);
    expect(title()).toBe('Renamed at 12');
    // A delta at exactly the loaded version is already part of the load too.
    applyDelta({ version: 12, deletedWorkItemIds: [1] });
    expect(title()).toBe('Renamed at 12');
    // Newer changes still apply.
    applyDelta({ version: 13, workItems: [item('Renamed at 13')] });
    expect(title()).toBe('Renamed at 13');
    expect(useStore.getState().version).toBe(13);
  });
});
