import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app';
import { AuthManager } from './auth';
import { emptyDatabase } from './schema';
import { buildDemoDatabase } from './seed';
import { Security } from './security';
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

const trustProxy = parseTrustProxy(process.env.TRUST_PROXY);
// SECURITY_ALLOWLIST: comma-separated IPs or IPv4 CIDR ranges never rate limited or blocked
// (for example an office's shared address).
const security = new Security({ allowlist: (process.env.SECURITY_ALLOWLIST ?? '').split(',') });
security.start();
const app = createApp({ store, snapshots, auth, trustProxy, security, staticDir: path.join(root, 'dist', 'client') });

const server = app.listen(port, () => {
  console.log(`Boards server listening on http://localhost:${port} (data in ${dataDir})`);
});
// Drop clients that send requests too slowly (slowloris) or hold idle connections open.
server.headersTimeout = 15_000;
server.requestTimeout = 120_000; // time to receive a whole request, including a large backup upload
server.keepAliveTimeout = 30_000;
server.maxHeadersCount = 100;
server.maxRequestsPerSocket = 1000;

// Containers stop with SIGTERM. Every write is already on disk, so just stop taking requests
// and exit promptly; open live-update streams would otherwise keep the server alive.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    console.log(`${signal} received, shutting down`);
    snapshots.stopScheduler();
    security.stop();
    server.close(() => process.exit(0));
    server.closeAllConnections();
  });
}

/** TRUST_PROXY: unset = off, "true"/"false", a hop count, or an address/subnet list. */
function parseTrustProxy(value: string | undefined): boolean | number | string | undefined {
  if (value === undefined || value === '') return undefined;
  if (/^(true|false)$/i.test(value)) return value.toLowerCase() === 'true';
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}
