import type { MemberRepository } from '#domain/team/repository.ts';
import { Member, type MemberId } from '#domain/team/member.ts';
import type { CurrentTransaction } from './unit-of-work.ts';

/** Team members. Changes here also run the store's guards (see Store.addGuard). */
export class JsonMemberRepository implements MemberRepository {
  readonly #tx: CurrentTransaction;

  constructor(tx: CurrentTransaction) {
    this.#tx = tx;
  }

  async findById(id: MemberId): Promise<Member | undefined> {
    const row = this.#tx.current().db.members.find((m) => m.id === id);
    return row ? Member.reconstitute(row) : undefined;
  }

  async findAll(): Promise<Member[]> {
    return this.#tx.current().db.members.map((m) => Member.reconstitute(m));
  }

  async save(member: Member): Promise<void> {
    const tx = this.#tx.current();
    const row = member.toSnapshot();
    const idx = tx.db.members.findIndex((m) => m.id === row.id);
    if (idx >= 0) tx.db.members[idx] = row;
    else tx.db.members.push(row);
    tx.members.add(row.id);
  }

  async delete(id: MemberId): Promise<void> {
    const tx = this.#tx.current();
    tx.db.members = tx.db.members.filter((m) => m.id !== id);
    tx.deletedMembers.add(id);
  }
}
