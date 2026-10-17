import type { Brand } from '#shared/brand.ts';
import { err, ok, type Result } from '#shared/result.ts';
import type { Member as MemberData } from '../types.ts';

export type MemberId = Brand<string, 'MemberId'>;

export const MAX_MEMBER_NAME_LENGTH = 128;
export const MAX_USERNAME_LENGTH = 64;
export const MAX_EMAIL_LENGTH = 256;
/** Colours handed out to new members in turn. */
export const MEMBER_COLORS = ['#0078d4', '#8764b8', '#00b294', '#e3008c', '#ca5010', '#498205', '#038387', '#c239b3', '#986f0b', '#4f6bed'] as const;
const MAX_ID_LENGTH = 128;

export type MemberError =
  | { readonly code: 'MEMBER_NOT_FOUND'; readonly id: string }
  | { readonly code: 'MEMBER_NAME_REQUIRED' }
  | { readonly code: 'TEXT_TOO_LONG'; readonly field: 'name' | 'username' | 'email'; readonly max: number }
  | { readonly code: 'USERNAME_INVALID' }
  | { readonly code: 'USERNAME_TAKEN'; readonly username: string; readonly takenBy: string }
  | { readonly code: 'INVALID_COLOR' };

export type MemberEvent =
  | { readonly type: 'MemberAdded'; readonly memberId: string; readonly occurredAt: Date }
  | { readonly type: 'MemberChanged'; readonly memberId: string; readonly occurredAt: Date }
  | { readonly type: 'MemberRemoved'; readonly memberId: string; readonly occurredAt: Date };

/** A member id that could never have been issued is reported as not found. */
export function toMemberId(raw: string): Result<MemberId, MemberError> {
  if (!raw || raw.length > MAX_ID_LENGTH) return err({ code: 'MEMBER_NOT_FOUND', id: raw });
  return ok(raw as MemberId);
}

export interface MemberInput {
  readonly name?: string | undefined;
  readonly username?: string | undefined;
  readonly email?: string | undefined;
  readonly color?: string | undefined;
  readonly active?: boolean | undefined;
}

type MemberValues = { -readonly [K in keyof MemberInput]?: Exclude<MemberInput[K], undefined> };

/** Validated member fields, trimmed. */
export class MemberChanges {
  readonly #values: Readonly<MemberValues>;

  private constructor(values: MemberValues) {
    this.#values = Object.freeze(values);
    Object.freeze(this);
  }

  static validate(input: MemberInput): Result<MemberChanges, MemberError> {
    const out: MemberValues = {};
    if (input.name !== undefined) {
      const name = input.name.trim();
      if (!name) return err({ code: 'MEMBER_NAME_REQUIRED' });
      if (name.length > MAX_MEMBER_NAME_LENGTH) return err({ code: 'TEXT_TOO_LONG', field: 'name', max: MAX_MEMBER_NAME_LENGTH });
      out.name = name;
    }
    if (input.username !== undefined) {
      // Usernames are optional (blank), but sign-in needs one, so they stay simple.
      const username = input.username.trim();
      if (username.length > MAX_USERNAME_LENGTH) return err({ code: 'TEXT_TOO_LONG', field: 'username', max: MAX_USERNAME_LENGTH });
      if (!/^[A-Za-z0-9._-]*$/.test(username)) return err({ code: 'USERNAME_INVALID' });
      out.username = username;
    }
    if (input.email !== undefined) {
      const email = input.email.trim();
      if (email.length > MAX_EMAIL_LENGTH) return err({ code: 'TEXT_TOO_LONG', field: 'email', max: MAX_EMAIL_LENGTH });
      out.email = email;
    }
    if (input.color !== undefined) {
      if (!/^#[0-9a-f]{6}$/i.test(input.color)) return err({ code: 'INVALID_COLOR' });
      out.color = input.color;
    }
    if (input.active !== undefined) out.active = input.active;
    return ok(new MemberChanges(out));
  }

  get values(): Readonly<MemberValues> {
    return this.#values;
  }
}

/** A username may be blank, but when set no one else may have it, ignoring case. */
function usernameTakenBy(username: string | undefined, others: readonly Member[]): Member | undefined {
  if (!username) return undefined;
  return others.find((m) => m.username && m.username.toLowerCase() === username.toLowerCase());
}

export class Member {
  readonly #props: MemberData;
  #events: MemberEvent[] = [];

  private constructor(props: MemberData) {
    this.#props = props;
  }

  static create(changes: MemberChanges, input: { readonly id: MemberId; readonly existing: readonly Member[]; readonly now: Date }): Result<Member, MemberError> {
    const v = changes.values;
    if (v.name === undefined) return err({ code: 'MEMBER_NAME_REQUIRED' });
    const taken = usernameTakenBy(v.username, input.existing);
    if (taken && v.username) return err({ code: 'USERNAME_TAKEN', username: v.username, takenBy: taken.name });
    const member = new Member({
      id: input.id,
      name: v.name,
      username: v.username ?? '',
      email: v.email ?? '',
      color: v.color ?? MEMBER_COLORS[input.existing.length % MEMBER_COLORS.length] ?? MEMBER_COLORS[0],
      active: v.active ?? true,
    });
    member.#events.push({ type: 'MemberAdded', memberId: input.id, occurredAt: input.now });
    return ok(member);
  }

  static reconstitute(snapshot: MemberData): Member {
    if (typeof snapshot.id !== 'string' || !snapshot.id) throw new Error('Stored member has no id');
    return new Member({ ...snapshot });
  }

  get id(): MemberId {
    return this.#props.id as MemberId;
  }
  get name(): string {
    return this.#props.name;
  }
  get username(): string {
    return this.#props.username;
  }

  /** Change the given fields. `others` are the rest of the team, for the username check. */
  update(changes: MemberChanges, others: readonly Member[], now: Date): Result<void, MemberError> {
    const { username } = changes.values;
    const taken = usernameTakenBy(username, others.filter((m) => m.id !== this.id));
    if (taken && username) return err({ code: 'USERNAME_TAKEN', username, takenBy: taken.name });
    Object.assign(this.#props, changes.values);
    this.#events.push({ type: 'MemberChanged', memberId: this.#props.id, occurredAt: now });
    return ok(undefined);
  }

  markRemoved(now: Date): void {
    this.#events.push({ type: 'MemberRemoved', memberId: this.#props.id, occurredAt: now });
  }

  /** History note on work left without an assignee when the member leaves. */
  get removalNote(): string {
    return `${this.#props.name} was removed from the team`;
  }

  pullEvents(): readonly MemberEvent[] {
    const events = this.#events;
    this.#events = [];
    return events;
  }

  toSnapshot(): MemberData {
    return { ...this.#props };
  }
}
