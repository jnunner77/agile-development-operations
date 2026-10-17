import type { Brand } from '#shared/brand.ts';
import { err, ok, type Result } from '#shared/result.ts';
import { isValidDate } from '../dates.ts';
import type { Sprint as SprintData } from '../types.ts';

export type SprintId = Brand<string, 'SprintId'>;

export const MAX_SPRINT_NAME_LENGTH = 128;
export const MAX_SPRINT_GOAL_LENGTH = 4000;
const MAX_ID_LENGTH = 128;

export type SprintError =
  | { readonly code: 'SPRINT_NOT_FOUND'; readonly id: string }
  | { readonly code: 'SPRINT_NAME_REQUIRED' }
  | { readonly code: 'TEXT_TOO_LONG'; readonly field: 'name' | 'goal'; readonly max: number }
  | { readonly code: 'INVALID_DATE'; readonly field: 'startDate' | 'finishDate' }
  | { readonly code: 'SPRINT_DATES_INCOMPLETE' }
  | { readonly code: 'SPRINT_DATES_REVERSED' }
  | { readonly code: 'SPRINT_NAME_TAKEN'; readonly name: string }
  | { readonly code: 'SPRINT_MOVE_TO_SELF' };

export type SprintEvent =
  | { readonly type: 'SprintCreated'; readonly sprintId: string; readonly occurredAt: Date }
  | { readonly type: 'SprintChanged'; readonly sprintId: string; readonly occurredAt: Date }
  | { readonly type: 'SprintDeleted'; readonly sprintId: string; readonly occurredAt: Date };

/** A sprint id that could never have been issued is reported as not found. */
export function toSprintId(raw: string): Result<SprintId, SprintError> {
  if (!raw || raw.length > MAX_ID_LENGTH) return err({ code: 'SPRINT_NOT_FOUND', id: raw });
  return ok(raw as SprintId);
}

export interface SprintInput {
  readonly name?: string | undefined;
  readonly startDate?: string | null | undefined;
  readonly finishDate?: string | null | undefined;
  readonly goal?: string | undefined;
}

type SprintValues = { -readonly [K in keyof SprintInput]?: Exclude<SprintInput[K], undefined> };

/** Validated sprint fields: the name trimmed and every value within its limits. */
export class SprintChanges {
  readonly #values: Readonly<SprintValues>;

  private constructor(values: SprintValues) {
    this.#values = Object.freeze(values);
    Object.freeze(this);
  }

  static validate(input: SprintInput): Result<SprintChanges, SprintError> {
    const out: SprintValues = {};
    if (input.name !== undefined) {
      const name = input.name.trim();
      if (!name) return err({ code: 'SPRINT_NAME_REQUIRED' });
      if (name.length > MAX_SPRINT_NAME_LENGTH) return err({ code: 'TEXT_TOO_LONG', field: 'name', max: MAX_SPRINT_NAME_LENGTH });
      out.name = name;
    }
    for (const field of ['startDate', 'finishDate'] as const) {
      const value = input[field];
      if (value === undefined) continue;
      if (value !== null && !isValidDate(value)) return err({ code: 'INVALID_DATE', field });
      out[field] = value;
    }
    if (input.goal !== undefined) {
      if (input.goal.length > MAX_SPRINT_GOAL_LENGTH) return err({ code: 'TEXT_TOO_LONG', field: 'goal', max: MAX_SPRINT_GOAL_LENGTH });
      out.goal = input.goal;
    }
    return ok(new SprintChanges(out));
  }

  get values(): Readonly<SprintValues> {
    return this.#values;
  }
}

/** A sprint is dated by both a start and a finish, or by neither, and can't end before it starts. */
function checkDates(start: string | null, finish: string | null): Result<void, SprintError> {
  if ((start === null) !== (finish === null)) return err({ code: 'SPRINT_DATES_INCOMPLETE' });
  if (start !== null && finish !== null && finish < start) return err({ code: 'SPRINT_DATES_REVERSED' });
  return ok(undefined);
}

/** Sprint names are unique, ignoring case. */
function nameTaken(name: string, others: readonly Sprint[]): boolean {
  return others.some((s) => s.name.toLowerCase() === name.toLowerCase());
}

export class Sprint {
  readonly #props: SprintData;
  #events: SprintEvent[] = [];

  private constructor(props: SprintData) {
    this.#props = props;
  }

  static create(
    changes: SprintChanges,
    input: { readonly id: SprintId; readonly existing: readonly Sprint[]; readonly now: Date },
  ): Result<Sprint, SprintError> {
    const v = changes.values;
    if (v.name === undefined) return err({ code: 'SPRINT_NAME_REQUIRED' });
    const startDate = v.startDate ?? null;
    const finishDate = v.finishDate ?? null;
    const dates = checkDates(startDate, finishDate);
    if (!dates.ok) return dates;
    if (nameTaken(v.name, input.existing)) return err({ code: 'SPRINT_NAME_TAKEN', name: v.name });
    const sprint = new Sprint({ id: input.id, name: v.name, startDate, finishDate, goal: v.goal ?? '' });
    sprint.#events.push({ type: 'SprintCreated', sprintId: input.id, occurredAt: input.now });
    return ok(sprint);
  }

  static reconstitute(snapshot: SprintData): Sprint {
    if (typeof snapshot.id !== 'string' || !snapshot.id) throw new Error('Stored sprint has no id');
    return new Sprint({ ...snapshot });
  }

  get id(): SprintId {
    return this.#props.id as SprintId;
  }
  get name(): string {
    return this.#props.name;
  }
  get startDate(): string | null {
    return this.#props.startDate;
  }
  get finishDate(): string | null {
    return this.#props.finishDate;
  }

  /** Change the given fields. `others` are the project's other sprints, for the name check. */
  update(changes: SprintChanges, others: readonly Sprint[], now: Date): Result<void, SprintError> {
    const next: SprintData = { ...this.#props, ...changes.values };
    const dates = checkDates(next.startDate, next.finishDate);
    if (!dates.ok) return dates;
    const { name } = changes.values;
    if (name !== undefined && nameTaken(name, others.filter((s) => s.id !== this.id))) return err({ code: 'SPRINT_NAME_TAKEN', name });
    Object.assign(this.#props, next);
    this.#events.push({ type: 'SprintChanged', sprintId: this.#props.id, occurredAt: now });
    return ok(undefined);
  }

  markDeleted(now: Date): void {
    this.#events.push({ type: 'SprintDeleted', sprintId: this.#props.id, occurredAt: now });
  }

  pullEvents(): readonly SprintEvent[] {
    const events = this.#events;
    this.#events = [];
    return events;
  }

  toSnapshot(): SprintData {
    return { ...this.#props };
  }
}

/** The dated sprint that most recently started before `sprint`, whose capacity carries forward. */
export function previousSprint(sprint: Sprint, sprints: readonly Sprint[]): Sprint | undefined {
  const start = sprint.startDate;
  if (!start) return undefined;
  return [...sprints]
    .filter((s) => s.id !== sprint.id && s.startDate !== null && s.startDate < start)
    .sort((a, b) => (b.startDate ?? '').localeCompare(a.startDate ?? ''))[0];
}
