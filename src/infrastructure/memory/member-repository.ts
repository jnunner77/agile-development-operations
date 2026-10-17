import { Member, type MemberId } from '#domain/team/member.ts';
import type { MemberRepository } from '#domain/team/repository.ts';
import type { Member as MemberData } from '#domain/types.ts';
import type { Checkpointable } from './checkpoint.ts';

export class MemoryMemberRepository implements MemberRepository, Checkpointable {
  #rows: MemberData[];

  constructor(rows: readonly MemberData[] = []) {
    this.#rows = structuredClone([...rows]);
  }

  async findById(id: MemberId): Promise<Member | undefined> {
    const row = this.#rows.find((m) => m.id === id);
    return row ? Member.reconstitute(structuredClone(row)) : undefined;
  }

  async findAll(): Promise<Member[]> {
    return this.#rows.map((m) => Member.reconstitute(structuredClone(m)));
  }

  async save(member: Member): Promise<void> {
    const row = structuredClone(member.toSnapshot());
    const idx = this.#rows.findIndex((m) => m.id === row.id);
    if (idx >= 0) this.#rows[idx] = row;
    else this.#rows.push(row);
  }

  async delete(id: MemberId): Promise<void> {
    this.#rows = this.#rows.filter((m) => m.id !== id);
  }

  rows(): MemberData[] {
    return structuredClone(this.#rows);
  }

  checkpoint(): () => void {
    const rows = structuredClone(this.#rows);
    return () => {
      this.#rows = rows;
    };
  }
}
