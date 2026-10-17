import { MemberChanges, type MemberInput } from '#domain/team/member.ts';
import type { Member as MemberData } from '#domain/types.ts';
import { ok, type Result } from '#shared/result.ts';
import { requireAdmin } from '../access.ts';
import type { Caller } from '../caller.ts';
import type { Committed } from '../ports.ts';
import { runChange } from '../session.ts';
import { checkAdminRemains, findMember, type TeamDeps, type TeamError } from './deps.ts';

export interface UpdateMemberInput extends MemberInput {
  readonly caller: Caller;
  readonly id: string;
}

export class UpdateMember {
  readonly #deps: TeamDeps;

  constructor(deps: TeamDeps) {
    this.#deps = deps;
  }

  async execute(input: UpdateMemberInput): Promise<Result<Committed<MemberData>, TeamError>> {
    const access = requireAdmin(input.caller);
    if (!access.ok) return access;
    const changes = MemberChanges.validate(input);
    if (!changes.ok) return changes;
    return runChange<MemberData, TeamError>(this.#deps, input.caller, async (session) => {
      const member = await findMember(this.#deps, input.id);
      if (!member.ok) return member;
      const team = await this.#deps.members.findAll();
      const updated = member.value.update(changes.value, team, session.now);
      if (!updated.ok) return updated;
      // Deactivating an administrator, or clearing their username, can lock everyone out.
      const remains = await checkAdminRemains(this.#deps, team.map((m) => (m.id === member.value.id ? member.value : m)));
      if (!remains.ok) return remains;
      await this.#deps.members.save(member.value);
      session.record(member.value);
      return ok(member.value.toSnapshot());
    });
  }
}
