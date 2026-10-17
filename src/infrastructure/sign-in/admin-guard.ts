import { hasUsableAdmin } from '#domain/sign-in/admins.ts';
import { RejectedChangeError, type Store } from '../json-store/store.ts';
import type { AuthFile } from './auth-file.ts';

/**
 * With sign-in on, every change to the project's members (including a snapshot restore, a backup
 * import or a reset) must leave an administrator who can sign in. The use cases check this before
 * changing anything; this guard backs them up for whole-database replacements.
 */
export function guardUsableAdmin(store: Store, file: AuthFile, forcedOff: boolean): void {
  store.addGuard((db) => {
    const enabled = file.settings.enabled && !forcedOff;
    if (enabled && !hasUsableAdmin(db.members, (id) => file.account(id))) {
      throw new RejectedChangeError(
        'Sign-in is turned on, so at least one active administrator with a username and a password must remain. Make someone else an administrator first, or turn sign-in off.',
      );
    }
  });
}
