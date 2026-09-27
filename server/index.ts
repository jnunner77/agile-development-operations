import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app';
import { AuthManager } from './auth';
import { emptyDatabase } from './schema';
import { buildDemoDatabase } from './seed';
import { SnapshotManager } from './snapshots';
import { Store } from './store';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.resolve(process.env.DATA_DIR ?? path.join(root, 'data'));
const port = Number(process.env.PORT ?? 4000);
const seed = (process.env.SEED ?? 'demo') === 'demo';

const store = new Store(dataDir, () => (seed ? buildDemoDatabase() : emptyDatabase()));
const snapshots = new SnapshotManager(store);
snapshots.startScheduler();

// AUTH_DISABLED=1 forces sign-in off, e.g. to recover if every administrator is locked out.
const authDisabled = /^(1|true|yes)$/i.test(process.env.AUTH_DISABLED ?? '');
const auth = new AuthManager(store, { disabled: authDisabled });
if (authDisabled) console.warn('AUTH_DISABLED is set: sign-in is turned off and anyone can use the app.');

const app = createApp({ store, snapshots, auth, staticDir: path.join(root, 'dist', 'client') });

app.listen(port, () => {
  console.log(`Boards server listening on http://localhost:${port} (data in ${dataDir})`);
});
