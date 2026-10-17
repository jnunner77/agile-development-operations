import { ApiToken, ApiTokenDraft, checkTokenLimit, type ApiTokenInfo } from '#domain/api-tokens/api-token.ts';
import { err, ok, type Result } from '#shared/result.ts';
import type { Caller } from '../caller.ts';
import { publish, type ApiTokensError, type SignInDeps } from '../sign-in/deps.ts';
import { findTeamMember } from '../sign-in/team.ts';
import { forgetStaleTokens, managesAllTokens } from './rules.ts';

export interface CreateApiTokenInput {
  readonly caller: Caller;
  readonly name: string;
  /** Who the token acts as. Default: the caller. */
  readonly memberId?: string | undefined;
  readonly scope?: string | undefined;
  readonly expiresInDays?: number | undefined;
}

/** Create a token. The secret is returned this once; only its digest is kept. */
export class CreateApiToken {
  readonly #deps: SignInDeps;

  constructor(deps: SignInDeps) {
    this.#deps = deps;
  }

  async execute(input: CreateApiTokenInput): Promise<Result<{ readonly token: string; readonly info: ApiTokenInfo }, ApiTokensError>> {
    const draft = ApiTokenDraft.of(input);
    if (!draft.ok) return draft;
    const deps = this.#deps;
    const memberId = input.memberId ?? input.caller.memberId;
    if (!memberId) return err({ code: 'TOKEN_MEMBER_REQUIRED' });
    if (!managesAllTokens(input.caller) && memberId !== input.caller.memberId) return err({ code: 'TOKEN_FOR_SOMEONE_ELSE', action: 'create' });
    const member = await findTeamMember(deps, memberId);
    if (!member.ok) return member;
    if (!member.value.active) return err({ code: 'TOKEN_MEMBER_INACTIVE', name: member.value.name });
    // Recorded as created by the caller's member, never by whatever name a browser sent.
    const creator = input.caller.memberId ? ((await deps.team.findById(input.caller.memberId))?.name ?? 'Anonymous') : 'Anonymous';
    const secret = deps.secrets.newApiToken();
    const created = await deps.signInWrites.run(async (): Promise<Result<ApiToken, ApiTokensError>> => {
      await forgetStaleTokens(deps);
      const now = deps.clock.now();
      const limit = checkTokenLimit(await deps.apiTokens.all(), member.value, now);
      if (!limit.ok) return limit;
      const token = ApiToken.create(draft.value, { id: deps.ids.next(), memberId, secret, digest: deps.secrets.digest(secret), createdBy: creator, now });
      await deps.apiTokens.save(token);
      return ok(token);
    });
    if (!created.ok) return created;
    await publish(deps, created.value);
    return ok({ token: secret, info: created.value.toInfo(deps.clock.now()) });
  }
}
