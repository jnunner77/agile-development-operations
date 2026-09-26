import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { isValidDate } from '../shared/dates';
import type { SprintCapacity } from '../shared/types';
import { badRequest } from './errors';
import { applyPatch } from './workitems';
import type { Tx } from './store';

const date = z.string().refine(isValidDate, 'Expected a date in YYYY-MM-DD format');
const range = z
  .object({ start: date, end: date })
  .strict()
  .refine((r) => r.end >= r.start, 'Days off end date must be on or after the start date');

export const sprintSchema = z
  .object({
    name: z.string().trim().min(1, 'Sprint name is required').max(128),
    startDate: date.nullable(),
    finishDate: date.nullable(),
    goal: z.string().max(4000),
  })
  .partial()
  .strict();

export const memberSchema = z
  .object({
    name: z.string().trim().min(1, 'Name is required').max(128),
    email: z.string().trim().max(256),
    color: z.string().regex(/^#[0-9a-f]{6}$/i),
    active: z.boolean(),
  })
  .partial()
  .strict();

export const capacitySchema = z
  .object({
    teamDaysOff: z.array(range),
    members: z.array(
      z
        .object({
          memberId: z.string(),
          activities: z.array(z.object({ activity: z.string().max(64), capacityPerDay: z.number().min(0).max(24) }).strict()).max(10),
          daysOff: z.array(range),
        })
        .strict(),
    ),
  })
  .strict();

export const settingsSchema = z
  .object({
    projectName: z.string().trim().min(1).max(128),
    teamName: z.string().trim().min(1).max(128),
    workingDays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    areaPaths: z.array(z.string().trim().min(1).max(255)).min(1),
    backup: z
      .object({
        autoEnabled: z.boolean(),
        intervalHours: z.number().min(1).max(24 * 30),
        retain: z.number().int().min(1).max(365),
      })
      .strict(),
  })
  .partial()
  .strict();

const PALETTE = ['#0078d4', '#8764b8', '#00b294', '#e3008c', '#ca5010', '#498205', '#038387', '#c239b3', '#986f0b', '#4f6bed'];

function checkDates(start: string | null | undefined, finish: string | null | undefined) {
  if ((start == null) !== (finish == null)) throw badRequest('A sprint needs both a start and an end date, or neither');
  if (start && finish && finish < start) throw badRequest('Sprint end date must be on or after its start date');
}

export function createSprint(tx: Tx, input: z.infer<typeof sprintSchema>) {
  if (!input.name) throw badRequest('Sprint name is required');
  checkDates(input.startDate, input.finishDate);
  if (tx.db.sprints.some((s) => s.name.toLowerCase() === input.name!.toLowerCase())) {
    throw badRequest(`A sprint named "${input.name}" already exists`);
  }
  const sprint = {
    id: randomUUID(),
    name: input.name,
    startDate: input.startDate ?? null,
    finishDate: input.finishDate ?? null,
    goal: input.goal ?? '',
  };
  tx.db.sprints.push(sprint);
  tx.sprints.add(sprint.id);
  // Carry capacity settings forward from the most recent sprint so teams don't re-enter them.
  const previous = [...tx.db.sprints]
    .filter((s) => s.id !== sprint.id && s.startDate && sprint.startDate && s.startDate < sprint.startDate)
    .sort((a, b) => (b.startDate ?? '').localeCompare(a.startDate ?? ''))[0];
  const prevCap = previous && tx.db.capacities.find((c) => c.sprintId === previous.id);
  tx.db.capacities.push({
    sprintId: sprint.id,
    teamDaysOff: [],
    members: prevCap ? prevCap.members.map((m) => ({ memberId: m.memberId, activities: structuredClone(m.activities), daysOff: [] })) : [],
  });
  tx.capacities.add(sprint.id);
  return sprint;
}

export function updateSprint(tx: Tx, id: string, input: z.infer<typeof sprintSchema>) {
  const sprint = tx.sprint(id);
  const next = { ...sprint, ...input };
  checkDates(next.startDate, next.finishDate);
  if (input.name && tx.db.sprints.some((s) => s.id !== id && s.name.toLowerCase() === input.name!.toLowerCase())) {
    throw badRequest(`A sprint named "${input.name}" already exists`);
  }
  Object.assign(sprint, next);
  tx.sprints.add(id);
  return sprint;
}

/** Delete a sprint, moving its unfinished work to `moveTo` (another sprint or the backlog). */
export function deleteSprint(tx: Tx, id: string, moveTo: string | null) {
  tx.sprint(id);
  if (moveTo === id) throw badRequest('Choose a different destination for the sprint\'s work');
  if (moveTo) tx.sprint(moveTo);
  for (const item of tx.db.workItems) {
    if (item.iterationId === id) applyPatch(tx, item, { iterationId: moveTo }, 'Sprint was deleted');
  }
  tx.db.sprints = tx.db.sprints.filter((s) => s.id !== id);
  tx.db.capacities = tx.db.capacities.filter((c) => c.sprintId !== id);
  tx.deletedSprints.add(id);
}

export function getCapacity(tx: Tx, sprintId: string): SprintCapacity {
  tx.sprint(sprintId);
  let cap = tx.db.capacities.find((c) => c.sprintId === sprintId);
  if (!cap) {
    cap = { sprintId, teamDaysOff: [], members: [] };
    tx.db.capacities.push(cap);
  }
  return cap;
}

export function setCapacity(tx: Tx, sprintId: string, input: z.infer<typeof capacitySchema>) {
  const cap = getCapacity(tx, sprintId);
  const seen = new Set<string>();
  for (const m of input.members) {
    tx.member(m.memberId);
    if (seen.has(m.memberId)) throw badRequest('A team member can only appear once in capacity planning');
    seen.add(m.memberId);
  }
  cap.teamDaysOff = input.teamDaysOff;
  cap.members = input.members;
  tx.capacities.add(sprintId);
  return cap;
}

export function copyCapacity(tx: Tx, sprintId: string, fromSprintId: string) {
  const from = getCapacity(tx, fromSprintId);
  const cap = getCapacity(tx, sprintId);
  cap.members = from.members.map((m) => ({
    memberId: m.memberId,
    activities: structuredClone(m.activities),
    daysOff: cap.members.find((x) => x.memberId === m.memberId)?.daysOff ?? [],
  }));
  tx.capacities.add(sprintId);
  return cap;
}

export function createMember(tx: Tx, input: z.infer<typeof memberSchema>) {
  if (!input.name) throw badRequest('Name is required');
  const member = {
    id: randomUUID(),
    name: input.name,
    email: input.email ?? '',
    color: input.color ?? PALETTE[tx.db.members.length % PALETTE.length],
    active: input.active ?? true,
  };
  tx.db.members.push(member);
  tx.members.add(member.id);
  return member;
}

export function updateMember(tx: Tx, id: string, input: z.infer<typeof memberSchema>) {
  const member = tx.member(id);
  Object.assign(member, input);
  tx.members.add(id);
  return member;
}

export function deleteMember(tx: Tx, id: string) {
  const member = tx.member(id);
  for (const item of tx.db.workItems) {
    if (item.assignedTo === id) applyPatch(tx, item, { assignedTo: null }, `${member.name} was removed from the team`);
  }
  for (const cap of tx.db.capacities) {
    if (cap.members.some((m) => m.memberId === id)) {
      cap.members = cap.members.filter((m) => m.memberId !== id);
      tx.capacities.add(cap.sprintId);
    }
  }
  tx.db.members = tx.db.members.filter((m) => m.id !== id);
  tx.deletedMembers.add(id);
}

export function updateSettings(tx: Tx, input: z.infer<typeof settingsSchema>) {
  Object.assign(tx.db.settings, input);
  if (input.workingDays) tx.db.settings.workingDays = [...new Set(input.workingDays)].sort();
  tx.settings = true;
  return tx.db.settings;
}
