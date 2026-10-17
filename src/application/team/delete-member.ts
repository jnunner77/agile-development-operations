import { FieldChanges } from '#domain/work-items/fields.ts';
import { ok, type Result } from '#shared/result.ts';
import { requireAdmin } from '../access.ts';
import type { Caller } from '../caller.ts';
import type { Committed } from '../ports.ts';
import { runChange } from '../session.ts';
import { editItem } from '../work-items/helpers.ts';
import { checkAdminRemains, findMember, type TeamDeps, type TeamError } from './deps.ts';

export interface DeleteMemberInput {
  readonly caller: Caller;
  readonly id: string;
}

/** Remove someone from the team: their work is unassigned and they leave every capacity plan. */
export class DeleteMember {
  readonly #deps: TeamDeps;

  constructor(deps: TeamDeps) {
    this.#deps = deps;
  }

  async execute(input: DeleteMemberInput): Promise<Result<Committed<void>, TeamError>> {
    const access = requireAdmin(input.caller);
    if (!access.ok) return access;
    const unassign = FieldChanges.validate({ assignedTo: null });
    if (!unassign.ok) return unassign;
    return runChange<void, TeamError>(this.#deps, input.caller, async (session) => {
      const { items, capacities, members } = this.#deps;
      const found = await findMember(this.#deps, input.id);
      if (!found.ok) return found;
      const member = found.value;
      const remains = await checkAdminRemains(this.#deps, (await members.findAll()).filter((m) => m.id !== member.id));
      if (!remains.ok) return remains;

      for (const item of await items.findAssignedTo(member.id)) {
        const unassigned = await editItem(this.#deps, session, item, unassign.value, { cascade: false, note: member.removalNote });
        if (!unassigned.ok) return unassigned;
      }
      for (const plan of await capacities.findAll()) {
        if (!plan.removeMember(member.id, session.now)) continue;
        await capacities.save(plan);
        session.record(plan);
      }
      member.markRemoved(session.now);
      await members.delete(member.id);
      session.record(member);
      return ok(undefined);
    });
  }
}
