import assert from 'node:assert/strict';
import type { Caller } from '#application/caller.ts';
import type { WorkItemDeps } from '#application/work-items/deps.ts';
import { CreateWorkItem } from '#application/work-items/create-work-item.ts';
import type { DomainEvent } from '#domain/events.ts';
import type { WorkItem } from '#domain/types.ts';
import { MemoryLinkRepository } from '#infrastructure/memory/link-repository.ts';
import { MemoryProjectDirectory } from '#infrastructure/memory/project-directory.ts';
import { MemoryRecycleBinRepository } from '#infrastructure/memory/recycle-bin-repository.ts';
import { MemoryUnitOfWork } from '#infrastructure/memory/unit-of-work.ts';
import { MemoryWorkItemRepository } from '#infrastructure/memory/work-item-repository.ts';
import type { Result } from '#shared/result.ts';

export const NOW = new Date('2026-03-02T10:00:00.000Z');

export const ann: Caller = { name: 'Ann', memberId: 'm1', mayModerateComments: false, origin: 'tab-1' };
export const bo: Caller = { name: 'Bo', memberId: 'm2', mayModerateComments: false, origin: undefined };
export const admin: Caller = { name: 'Admin', memberId: 'm3', mayModerateComments: true, origin: undefined };

export function setup() {
  const items = new MemoryWorkItemRepository();
  const links = new MemoryLinkRepository();
  const recycleBin = new MemoryRecycleBinRepository();
  const project = new MemoryProjectDirectory({ members: ['m1', 'm2', 'm3'], sprints: ['s1', 's2'] });
  const unitOfWork = new MemoryUnitOfWork([items, links, recycleBin]);
  const published: DomainEvent[] = [];
  let n = 0;
  const deps: WorkItemDeps = {
    items,
    links,
    recycleBin,
    project,
    clock: { now: () => NOW },
    ids: { next: () => `id-${++n}` },
    events: {
      publish: async (events) => {
        published.push(...events);
      },
    },
    unitOfWork,
  };
  const item = (id: number): WorkItem => {
    const row = items.rows().find((w) => w.id === id);
    assert.ok(row, `work item ${id} exists`);
    return row;
  };
  const create = async (type: string, fields: Record<string, unknown> = {}, caller: Caller = ann): Promise<WorkItem> => {
    const result = await new CreateWorkItem(deps).execute({ caller, type, fields: { title: `${type} item`, ...fields } });
    assert.ok(result.ok, JSON.stringify(result));
    return result.value.result;
  };
  return { deps, items, links, recycleBin, project, unitOfWork, published, item, create };
}

export function unwrap<T, E>(result: Result<T, E>): T {
  assert.ok(result.ok, JSON.stringify(result));
  return result.value;
}
