// Starts the Boards server. Configuration comes from the environment (see deploy/README.md).

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyDatabase } from '#infrastructure/json-store/schema.ts';
import { Store } from '#infrastructure/json-store/store.ts';
import { LocalEventBus } from '#infrastructure/local-event-bus.ts';
import { buildDemoDatabase } from '#infrastructure/json-store/demo-project.ts';
import { Security } from '../server/security.ts';
import { composeApp, createAuth } from './compose.ts';

const env = process.env;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.resolve(env['DATA_DIR'] ?? path.join(root, 'data'));
const port = Number(env['PORT'] ?? 4000);
const seed = (env['SEED'] ?? 'demo') === 'demo';

const store = new Store(dataDir, () => (seed ? buildDemoDatabase() : emptyDatabase()));

// AUTH_DISABLED=1 forces sign-in off, e.g. to recover if every administrator is locked out.
const authDisabled = /^(1|true|yes)$/i.test(env['AUTH_DISABLED'] ?? '');
const auth = createAuth(store, { disabled: authDisabled });
if (authDisabled) console.warn('AUTH_DISABLED is set: sign-in is turned off and anyone can use the app.');

// SECURITY_ALLOWLIST: comma-separated IPs or IPv4 CIDR ranges never rate limited or blocked
// (for example an office's shared address).
const security = new Security({ allowlist: (env['SECURITY_ALLOWLIST'] ?? '').split(',') });
security.start();

// EVENT_LOG=1 prints every domain event, for following what the app does.
const events = new LocalEventBus();
if (/^(1|true|yes)$/i.test(env['EVENT_LOG'] ?? '')) events.subscribe((event) => console.log(JSON.stringify(event)));

const { app, startBackupSchedule } = composeApp({
  store,
  auth,
  security,
  events,
  trustProxy: parseTrustProxy(env['TRUST_PROXY']),
  staticDir: path.join(root, 'dist', 'client'),
});

const stopBackups = startBackupSchedule();

const server = http.createServer(app);
// Drop clients that send requests too slowly (slowloris) or hold idle connections open.
server.headersTimeout = 15_000;
server.requestTimeout = 120_000; // time to receive a whole request, including a large backup upload
server.keepAliveTimeout = 30_000;
server.maxHeadersCount = 100;
server.maxRequestsPerSocket = 1000;
server.listen(port, () => {
  console.log(`Boards server listening on http://localhost:${port} (data in ${dataDir})`);
});

// Containers stop with SIGTERM. Every write is already on disk, so just stop taking requests
// and exit promptly; open live-update streams would otherwise keep the server alive.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    console.log(`${signal} received, shutting down`);
    stopBackups();
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
