import { TYPE_DEFS, stateCategory, type StateCategory, type WorkItemType } from '../process.ts';

/** Only these move along the board on their own; features and epics never do. */
const AUTOMATED: readonly WorkItemType[] = ['Product Backlog Item', 'Bug', 'Task'];
const ORDER: readonly StateCategory[] = ['Proposed', 'InProgress', 'Completed'];

/**
 * The state source control activity moves an item to: the first state of `category`, but only
 * forwards, and never for removed items. Null when the item stays where it is.
 */
export function advancedState(type: WorkItemType, state: string, category: 'InProgress' | 'Completed'): string | null {
  if (!AUTOMATED.includes(type)) return null;
  const current = stateCategory(type, state);
  if (current === 'Removed' || ORDER.indexOf(current) >= ORDER.indexOf(category)) return null;
  return TYPE_DEFS[type].states.find((s) => s.category === category)?.name ?? null;
}
