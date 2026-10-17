import type { FieldInput } from './fields.ts';
import { MAX_TITLE_LENGTH } from './fields.ts';
import type { WorkItemAggregate } from './work-item.ts';

export const copyTitle = (title: string): string => `Copy of ${title}`.slice(0, MAX_TITLE_LENGTH);

/**
 * The fields a copy keeps. The copy starts in its type's first state with no completed work,
 * comments, links or history of its own.
 */
export function copiedFields(source: WorkItemAggregate, title: string, parentId: number | null): FieldInput {
  const s = source.toSnapshot();
  return {
    title,
    parentId,
    iterationId: s.iterationId,
    assignedTo: s.assignedTo,
    areaPath: s.areaPath,
    priority: s.priority,
    effort: s.effort,
    businessValue: s.businessValue,
    timeCriticality: s.timeCriticality,
    valueArea: s.valueArea,
    risk: s.risk,
    severity: s.severity,
    activity: s.activity,
    originalEstimate: s.originalEstimate,
    remainingWork: s.remainingWork,
    startDate: s.startDate,
    targetDate: s.targetDate,
    dueDate: s.dueDate,
    description: s.description,
    acceptanceCriteria: s.acceptanceCriteria,
    reproSteps: s.reproSteps,
    systemInfo: s.systemInfo,
    foundInBuild: s.foundInBuild,
    tags: s.tags,
  };
}
