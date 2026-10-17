import { Member, MemberChanges, type MemberId, type MemberInput } from '#domain/team/member.ts';
import type { Member as MemberData } from '#domain/types.ts';
import { ok, type Result } from '#shared/result.ts';
import { requireAdmin } from '../access.ts';
import type { Caller } from '../caller.ts';
import type { Committed } from '../ports.ts';
import { runChange } from '../session.ts';
import type { TeamDeps, TeamError } from './deps.ts';

export interface CreateMemberInput extends MemberInput {
  readonly caller: Caller;
}

export class CreateMember {
  readonly #deps: TeamDeps;

  constructor(deps: TeamDeps) {
    this.#deps = deps;
  }

  async execute(input: CreateMemberInput): Promise<Result<Committed<MemberData>, TeamError>> {
    const access = requireAdmin(input.caller);
    if (!access.ok) return access;
    const changes = MemberChanges.validate(input);
    if (!changes.ok) return changes;
    return runChange(this.#deps, input.caller, async (session) => {
      const existing = await this.#deps.members.findAll();
      const created = Member.create(changes.value, { id: session.newId() as MemberId, existing, now: session.now });
      if (!created.ok) return created;
      await this.#deps.members.save(created.value);
      session.record(created.value);
      return ok(created.value.toSnapshot());
    });
  }
}
