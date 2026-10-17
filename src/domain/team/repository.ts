import type { Member, MemberId } from './member.ts';

export interface MemberRepository {
  findById(id: MemberId): Promise<Member | undefined>;
  /** The whole team, in the order members were added. */
  findAll(): Promise<Member[]>;
  save(member: Member): Promise<void>;
  delete(id: MemberId): Promise<void>;
}
