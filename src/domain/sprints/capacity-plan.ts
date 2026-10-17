import { err, ok, type Result } from '#shared/result.ts';
import { isValidDate } from '../dates.ts';
import type { ActivityCapacity, DateRange, MemberCapacity, SprintCapacity } from '../types.ts';
import type { SprintId } from './sprint.ts';

export const MAX_ACTIVITIES_PER_MEMBER = 10;
export const MAX_ACTIVITY_LENGTH = 64;
export const MAX_HOURS_PER_DAY = 24;

export type CapacityError =
  | { readonly code: 'INVALID_DATE'; readonly field: 'daysOff' }
  | { readonly code: 'DAYS_OFF_REVERSED' }
  | { readonly code: 'TOO_MANY_ACTIVITIES'; readonly max: number }
  | { readonly code: 'TEXT_TOO_LONG'; readonly field: 'activity'; readonly max: number }
  | { readonly code: 'NUMBER_OUT_OF_RANGE'; readonly field: 'capacityPerDay'; readonly min: number; readonly max: number }
  | { readonly code: 'MEMBER_LISTED_TWICE' };

export type CapacityEvent = { readonly type: 'CapacityChanged'; readonly sprintId: string; readonly occurredAt: Date };

export interface CapacityInput {
  readonly teamDaysOff: readonly DateRange[];
  readonly members: readonly MemberCapacity[];
}

function checkRanges(ranges: readonly DateRange[]): Result<DateRange[], CapacityError> {
  for (const r of ranges) {
    if (!isValidDate(r.start) || !isValidDate(r.end)) return err({ code: 'INVALID_DATE', field: 'daysOff' });
    if (r.end < r.start) return err({ code: 'DAYS_OFF_REVERSED' });
  }
  return ok(ranges.map((r) => ({ start: r.start, end: r.end })));
}

function checkActivities(activities: readonly ActivityCapacity[]): Result<ActivityCapacity[], CapacityError> {
  if (activities.length > MAX_ACTIVITIES_PER_MEMBER) return err({ code: 'TOO_MANY_ACTIVITIES', max: MAX_ACTIVITIES_PER_MEMBER });
  for (const a of activities) {
    if (a.activity.length > MAX_ACTIVITY_LENGTH) return err({ code: 'TEXT_TOO_LONG', field: 'activity', max: MAX_ACTIVITY_LENGTH });
    if (!(Number.isFinite(a.capacityPerDay) && a.capacityPerDay >= 0 && a.capacityPerDay <= MAX_HOURS_PER_DAY)) {
      return err({ code: 'NUMBER_OUT_OF_RANGE', field: 'capacityPerDay', min: 0, max: MAX_HOURS_PER_DAY });
    }
  }
  return ok(activities.map((a) => ({ activity: a.activity, capacityPerDay: a.capacityPerDay })));
}

/** A validated capacity plan: real date ranges, sensible hours, each member at most once. */
export class CapacityChanges {
  readonly #value: { readonly teamDaysOff: DateRange[]; readonly members: MemberCapacity[] };

  private constructor(value: { teamDaysOff: DateRange[]; members: MemberCapacity[] }) {
    this.#value = value;
    Object.freeze(this);
  }

  static validate(input: CapacityInput): Result<CapacityChanges, CapacityError> {
    const teamDaysOff = checkRanges(input.teamDaysOff);
    if (!teamDaysOff.ok) return teamDaysOff;
    const members: MemberCapacity[] = [];
    const seen = new Set<string>();
    for (const m of input.members) {
      if (seen.has(m.memberId)) return err({ code: 'MEMBER_LISTED_TWICE' });
      seen.add(m.memberId);
      const activities = checkActivities(m.activities);
      if (!activities.ok) return activities;
      const daysOff = checkRanges(m.daysOff);
      if (!daysOff.ok) return daysOff;
      members.push({ memberId: m.memberId, activities: activities.value, daysOff: daysOff.value });
    }
    return ok(new CapacityChanges({ teamDaysOff: teamDaysOff.value, members }));
  }

  get memberIds(): readonly string[] {
    return this.#value.members.map((m) => m.memberId);
  }

  get value(): { readonly teamDaysOff: readonly DateRange[]; readonly members: readonly MemberCapacity[] } {
    return this.#value;
  }
}

const cloneMember = (m: MemberCapacity): MemberCapacity => ({
  memberId: m.memberId,
  activities: m.activities.map((a) => ({ ...a })),
  daysOff: m.daysOff.map((d) => ({ ...d })),
});

/** Who is available in a sprint, for how many hours a day per activity, and who is off when. */
export class CapacityPlan {
  readonly #props: SprintCapacity;
  #events: CapacityEvent[] = [];

  private constructor(props: SprintCapacity) {
    this.#props = props;
  }

  static empty(sprintId: SprintId): CapacityPlan {
    return new CapacityPlan({ sprintId, teamDaysOff: [], members: [] });
  }

  /**
   * The plan a new sprint starts with: the people and activities of the previous sprint's plan,
   * so teams don't re-enter them, but none of its days off.
   */
  static carriedForward(sprintId: SprintId, previous: CapacityPlan | undefined): CapacityPlan {
    const members = previous ? previous.#props.members.map((m) => ({ ...cloneMember(m), daysOff: [] })) : [];
    return new CapacityPlan({ sprintId, teamDaysOff: [], members });
  }

  static reconstitute(snapshot: SprintCapacity): CapacityPlan {
    if (typeof snapshot.sprintId !== 'string' || !snapshot.sprintId) throw new Error('Stored capacity has no sprint');
    return new CapacityPlan({ sprintId: snapshot.sprintId, teamDaysOff: snapshot.teamDaysOff.map((d) => ({ ...d })), members: snapshot.members.map(cloneMember) });
  }

  get sprintId(): SprintId {
    return this.#props.sprintId as SprintId;
  }

  /** Replace the whole plan. The caller checks the members exist. */
  replace(changes: CapacityChanges, now: Date): void {
    this.#props.teamDaysOff = changes.value.teamDaysOff.map((d) => ({ ...d }));
    this.#props.members = changes.value.members.map(cloneMember);
    this.#changed(now);
  }

  /** Take another sprint's people and activities, keeping this sprint's own days off. */
  copyFrom(other: CapacityPlan, now: Date): void {
    const own = this.#props.members;
    this.#props.members = other.#props.members.map((m) => ({
      memberId: m.memberId,
      activities: m.activities.map((a) => ({ ...a })),
      daysOff: (own.find((x) => x.memberId === m.memberId)?.daysOff ?? []).map((d) => ({ ...d })),
    }));
    this.#changed(now);
  }

  /** Drop a member who left the team. Returns whether they were in the plan. */
  removeMember(memberId: string, now: Date): boolean {
    if (!this.#props.members.some((m) => m.memberId === memberId)) return false;
    this.#props.members = this.#props.members.filter((m) => m.memberId !== memberId);
    this.#changed(now);
    return true;
  }

  #changed(now: Date): void {
    this.#events.push({ type: 'CapacityChanged', sprintId: this.#props.sprintId, occurredAt: now });
  }

  pullEvents(): readonly CapacityEvent[] {
    const events = this.#events;
    this.#events = [];
    return events;
  }

  toSnapshot(): SprintCapacity {
    return { sprintId: this.#props.sprintId, teamDaysOff: this.#props.teamDaysOff.map((d) => ({ ...d })), members: this.#props.members.map(cloneMember) };
  }
}
