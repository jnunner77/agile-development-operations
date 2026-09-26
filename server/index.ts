import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app';
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

const app = createApp({ store, snapshots, staticDir: path.join(root, 'dist', 'client') });

app.listen(port, () => {
  console.log(`Boards server listening on http://localhost:${port} (data in ${dataDir})`);
});
