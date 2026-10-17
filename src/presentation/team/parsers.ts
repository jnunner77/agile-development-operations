import type { CapacityInput } from '#domain/sprints/capacity-plan.ts';
import type { SprintInput } from '#domain/sprints/sprint.ts';
import type { SettingsInput } from '#domain/settings/project-settings.ts';
import type { MemberInput } from '#domain/team/member.ts';
import type { ActivityCapacity, BackupSettings, DateRange, MemberCapacity } from '#domain/types.ts';
import { ok } from '#shared/result.ts';
import { arrayOf, boolean, nullable, number, object, optional, required, string, type Parsed, type Reader } from '../http/parse.ts';

// Request bodies for sprints, capacity, members and settings. Shape and JSON types only; the
// domain checks the values.

export function parseSprint(value: unknown): Parsed<SprintInput> {
  const body = object(value, ['name', 'startDate', 'finishDate', 'goal']);
  if (!body.ok) return body;
  const name = optional(body.value, 'name', string);
  if (!name.ok) return name;
  const startDate = optional(body.value, 'startDate', nullable(string));
  if (!startDate.ok) return startDate;
  const finishDate = optional(body.value, 'finishDate', nullable(string));
  if (!finishDate.ok) return finishDate;
  const goal = optional(body.value, 'goal', string);
  if (!goal.ok) return goal;
  return ok({ name: name.value, startDate: startDate.value, finishDate: finishDate.value, goal: goal.value });
}

export function parseMember(value: unknown): Parsed<MemberInput> {
  const body = object(value, ['name', 'username', 'email', 'color', 'active']);
  if (!body.ok) return body;
  const b = body.value;
  const name = optional(b, 'name', string);
  if (!name.ok) return name;
  const username = optional(b, 'username', string);
  if (!username.ok) return username;
  const email = optional(b, 'email', string);
  if (!email.ok) return email;
  const color = optional(b, 'color', string);
  if (!color.ok) return color;
  const active = optional(b, 'active', boolean);
  if (!active.ok) return active;
  return ok({ name: name.value, username: username.value, email: email.value, color: color.value, active: active.value });
}

const range: Reader<DateRange> = (value, key) => {
  const body = object(value, ['start', 'end'], key);
  if (!body.ok) return body;
  const start = required(body.value, 'start', string);
  if (!start.ok) return start;
  const end = required(body.value, 'end', string);
  if (!end.ok) return end;
  return ok({ start: start.value, end: end.value });
};

const activity: Reader<ActivityCapacity> = (value, key) => {
  const body = object(value, ['activity', 'capacityPerDay'], key);
  if (!body.ok) return body;
  const name = required(body.value, 'activity', string);
  if (!name.ok) return name;
  const hours = required(body.value, 'capacityPerDay', number);
  if (!hours.ok) return hours;
  return ok({ activity: name.value, capacityPerDay: hours.value });
};

const memberCapacity: Reader<MemberCapacity> = (value, key) => {
  const body = object(value, ['memberId', 'activities', 'daysOff'], key);
  if (!body.ok) return body;
  const memberId = required(body.value, 'memberId', string);
  if (!memberId.ok) return memberId;
  const activities = required(body.value, 'activities', arrayOf(activity));
  if (!activities.ok) return activities;
  const daysOff = required(body.value, 'daysOff', arrayOf(range));
  if (!daysOff.ok) return daysOff;
  return ok({ memberId: memberId.value, activities: activities.value, daysOff: daysOff.value });
};

export function parseCapacity(value: unknown): Parsed<CapacityInput> {
  const body = object(value, ['teamDaysOff', 'members']);
  if (!body.ok) return body;
  const teamDaysOff = required(body.value, 'teamDaysOff', arrayOf(range));
  if (!teamDaysOff.ok) return teamDaysOff;
  const members = required(body.value, 'members', arrayOf(memberCapacity));
  if (!members.ok) return members;
  return ok({ teamDaysOff: teamDaysOff.value, members: members.value });
}

export function parseCopyCapacity(value: unknown): Parsed<{ readonly fromSprintId: string }> {
  const body = object(value);
  if (!body.ok) return body;
  const from = required(body.value, 'fromSprintId', string);
  return from.ok ? ok({ fromSprintId: from.value }) : from;
}

const backup: Reader<BackupSettings> = (value, key) => {
  const body = object(value, ['autoEnabled', 'intervalHours', 'retain'], key);
  if (!body.ok) return body;
  const autoEnabled = required(body.value, 'autoEnabled', boolean);
  if (!autoEnabled.ok) return autoEnabled;
  const intervalHours = required(body.value, 'intervalHours', number);
  if (!intervalHours.ok) return intervalHours;
  const retain = required(body.value, 'retain', number);
  if (!retain.ok) return retain;
  return ok({ autoEnabled: autoEnabled.value, intervalHours: intervalHours.value, retain: retain.value });
};

export function parseSettings(value: unknown): Parsed<SettingsInput> {
  const body = object(value, ['projectName', 'teamName', 'workingDays', 'areaPaths', 'backup']);
  if (!body.ok) return body;
  const b = body.value;
  const projectName = optional(b, 'projectName', string);
  if (!projectName.ok) return projectName;
  const teamName = optional(b, 'teamName', string);
  if (!teamName.ok) return teamName;
  const workingDays = optional(b, 'workingDays', arrayOf(number));
  if (!workingDays.ok) return workingDays;
  const areaPaths = optional(b, 'areaPaths', arrayOf(string));
  if (!areaPaths.ok) return areaPaths;
  const backupSettings = optional(b, 'backup', backup);
  if (!backupSettings.ok) return backupSettings;
  return ok({
    projectName: projectName.value,
    teamName: teamName.value,
    workingDays: workingDays.value,
    areaPaths: areaPaths.value,
    backup: backupSettings.value,
  });
}
