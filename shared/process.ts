// Process template definition modelled on the Azure DevOps "Scrum" process.

export const WORK_ITEM_TYPES = ['Epic', 'Feature', 'Product Backlog Item', 'Bug', 'Task'] as const;
export type WorkItemType = (typeof WORK_ITEM_TYPES)[number];

export type StateCategory = 'Proposed' | 'InProgress' | 'Completed' | 'Removed';

export interface StateDef {
  name: string;
  category: StateCategory;
  color: string;
  /** Reason recorded when an item transitions into this state. */
  reason: string;
}

export type BacklogLevelKey = 'epics' | 'features' | 'requirements';

export interface TypeDef {
  name: WorkItemType;
  shortName: string;
  color: string;
  states: StateDef[];
  /** Types that may be the parent of this type. */
  parentTypes: WorkItemType[];
  /** Types that may be created as children of this type. */
  childTypes: WorkItemType[];
  level: BacklogLevelKey | 'tasks';
}

const S = {
  new: { name: 'New', category: 'Proposed', color: '#b2b2b2', reason: 'New' },
  approved: { name: 'Approved', category: 'Proposed', color: '#5688e0', reason: 'Approved by the Product Owner' },
  committed: { name: 'Committed', category: 'InProgress', color: '#007acc', reason: 'Commitment made by the team' },
  inProgress: { name: 'In Progress', category: 'InProgress', color: '#007acc', reason: 'Work started' },
  toDo: { name: 'To Do', category: 'Proposed', color: '#b2b2b2', reason: 'New task' },
  done: { name: 'Done', category: 'Completed', color: '#339933', reason: 'Work finished' },
  removed: { name: 'Removed', category: 'Removed', color: '#ffffff', reason: 'Removed from the backlog' },
} satisfies Record<string, StateDef>;

export const TYPE_DEFS: Record<WorkItemType, TypeDef> = {
  Epic: {
    name: 'Epic',
    shortName: 'Epic',
    color: '#ff7b00',
    states: [S.new, S.inProgress, S.done, S.removed],
    parentTypes: [],
    childTypes: ['Feature'],
    level: 'epics',
  },
  Feature: {
    name: 'Feature',
    shortName: 'Feature',
    color: '#773b93',
    states: [S.new, S.inProgress, S.done, S.removed],
    parentTypes: ['Epic'],
    childTypes: ['Product Backlog Item', 'Bug'],
    level: 'features',
  },
  'Product Backlog Item': {
    name: 'Product Backlog Item',
    shortName: 'PBI',
    color: '#009ccc',
    states: [S.new, S.approved, S.committed, S.done, S.removed],
    parentTypes: ['Feature'],
    childTypes: ['Task'],
    level: 'requirements',
  },
  Bug: {
    name: 'Bug',
    shortName: 'Bug',
    color: '#cc293d',
    states: [S.new, S.approved, S.committed, S.done, S.removed],
    parentTypes: ['Feature'],
    childTypes: ['Task'],
    level: 'requirements',
  },
  Task: {
    name: 'Task',
    shortName: 'Task',
    color: '#f2cb1d',
    states: [S.toDo, S.inProgress, S.done, S.removed],
    parentTypes: ['Product Backlog Item', 'Bug'],
    childTypes: [],
    level: 'tasks',
  },
};

export interface BacklogLevel {
  key: BacklogLevelKey;
  name: string;
  itemName: string;
  types: WorkItemType[];
  /** Level whose items appear as children when a row is expanded. */
  childTypes: WorkItemType[];
  /** Board columns, in order. */
  columns: string[];
}

export const BACKLOG_LEVELS: BacklogLevel[] = [
  {
    key: 'epics',
    name: 'Epics',
    itemName: 'Epic',
    types: ['Epic'],
    childTypes: ['Feature'],
    columns: ['New', 'In Progress', 'Done'],
  },
  {
    key: 'features',
    name: 'Features',
    itemName: 'Feature',
    types: ['Feature'],
    childTypes: ['Product Backlog Item', 'Bug'],
    columns: ['New', 'In Progress', 'Done'],
  },
  {
    key: 'requirements',
    name: 'Backlog items',
    itemName: 'Backlog item',
    types: ['Product Backlog Item', 'Bug'],
    childTypes: ['Task'],
    columns: ['New', 'Approved', 'Committed', 'Done'],
  },
];

export const TASK_COLUMNS = ['To Do', 'In Progress', 'Done'];

export const ACTIVITIES = ['Deployment', 'Design', 'Development', 'Documentation', 'Requirements', 'Testing'] as const;
export const SEVERITIES = ['1 - Critical', '2 - High', '3 - Medium', '4 - Low'] as const;
export const VALUE_AREAS = ['Business', 'Architectural'] as const;
export const RISKS = ['1 - High', '2 - Medium', '3 - Low'] as const;
export const PRIORITIES = [1, 2, 3, 4] as const;

export const LINK_TYPES = ['Related', 'Predecessor', 'Successor', 'Duplicate', 'Duplicate Of', 'Tests', 'Tested By'] as const;
export type LinkType = (typeof LINK_TYPES)[number];

/** Link types are stored in a canonical direction; this maps each to its reverse. */
export const LINK_REVERSE: Record<LinkType, LinkType> = {
  Related: 'Related',
  Predecessor: 'Successor',
  Successor: 'Predecessor',
  Duplicate: 'Duplicate Of',
  'Duplicate Of': 'Duplicate',
  Tests: 'Tested By',
  'Tested By': 'Tests',
};

export function typeDef(type: WorkItemType): TypeDef {
  return TYPE_DEFS[type];
}

export function stateDef(type: WorkItemType, state: string): StateDef | undefined {
  return TYPE_DEFS[type].states.find((s) => s.name === state);
}

export function stateCategory(type: WorkItemType, state: string): StateCategory {
  return stateDef(type, state)?.category ?? 'Proposed';
}

export function isClosed(type: WorkItemType, state: string): boolean {
  const c = stateCategory(type, state);
  return c === 'Completed' || c === 'Removed';
}

export function defaultState(type: WorkItemType): string {
  return TYPE_DEFS[type].states[0].name;
}

export function levelForType(type: WorkItemType): BacklogLevel | undefined {
  return BACKLOG_LEVELS.find((l) => l.types.includes(type));
}

export function canBeParent(parentType: WorkItemType, childType: WorkItemType): boolean {
  return TYPE_DEFS[childType].parentTypes.includes(parentType);
}

/** Fields shown on the work item form, per type. Used by both client and server validation. */
export const TYPE_FIELDS: Record<WorkItemType, string[]> = {
  Epic: ['description', 'acceptanceCriteria', 'priority', 'effort', 'businessValue', 'timeCriticality', 'valueArea', 'risk', 'startDate', 'targetDate', 'dueDate'],
  Feature: ['description', 'acceptanceCriteria', 'priority', 'effort', 'businessValue', 'timeCriticality', 'valueArea', 'risk', 'startDate', 'targetDate', 'dueDate'],
  'Product Backlog Item': ['description', 'acceptanceCriteria', 'priority', 'effort', 'businessValue', 'valueArea', 'originalEstimate', 'remainingWork', 'completedWork', 'dueDate'],
  Bug: ['reproSteps', 'systemInfo', 'acceptanceCriteria', 'priority', 'severity', 'effort', 'originalEstimate', 'remainingWork', 'completedWork', 'foundInBuild', 'integratedInBuild', 'valueArea', 'dueDate'],
  Task: ['description', 'priority', 'activity', 'originalEstimate', 'remainingWork', 'completedWork', 'blocked', 'dueDate'],
};
