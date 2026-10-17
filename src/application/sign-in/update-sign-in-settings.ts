import { accountsByMember, hasUsableAdmin } from '#domain/sign-in/admins.ts';
import { SignInSettingsChanges, type SignInSettings, type SignInSettingsInput } from '#domain/sign-in/settings.ts';
import { ok, type Result } from '#shared/result.ts';
import { requireAdmin } from '../access.ts';
import type { Caller } from '../caller.ts';
import type { AuthAdminView } from '../contracts/auth.ts';
import { publish, type SignInDeps, type SignInError } from './deps.ts';
import { adminView } from './helpers.ts';

export interface UpdateSignInSettingsInput extends SignInSettingsInput {
  readonly caller: Caller;
}

export class UpdateSignInSettings {
  readonly #deps: SignInDeps;

  constructor(deps: SignInDeps) {
    this.#deps = deps;
  }

  async execute(input: UpdateSignInSettingsInput): Promise<Result<AuthAdminView, SignInError>> {
    const access = requireAdmin(input.caller);
    if (!access.ok) return access;
    const changes = SignInSettingsChanges.validate(input);
    if (!changes.ok) return changes;
    const deps = this.#deps;
    const saved = await deps.signInWrites.run(async (): Promise<Result<SignInSettings, SignInError>> => {
      const settings = await deps.signInSettings.get();
      const usableAdmin = hasUsableAdmin(await deps.team.all(), accountsByMember(await deps.accounts.all()));
      const updated = settings.update(changes.value, usableAdmin, deps.clock.now());
      if (!updated.ok) return updated;
      await deps.signInSettings.save(settings);
      return ok(settings);
    });
    if (!saved.ok) return saved;
    await publish(deps, saved.value);
    return ok(await adminView(deps));
  }
}
