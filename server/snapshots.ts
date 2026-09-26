import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Database, SnapshotKind, SnapshotMeta } from '../shared/types';
import { notFound } from './errors';
import { normalizeDatabase } from './schema';
import type { Store } from './store';

interface SnapshotFile {
  format: 'ado-clone-snapshot';
  meta: SnapshotMeta;
  data: Database;
}

/**
 * Point-in-time copies of the whole database, stored as individual JSON files with a
 * small index so listing doesn't need to read every snapshot.
 */
export class SnapshotManager {
  private readonly dir: string;
  private readonly indexFile: string;
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly store: Store) {
    this.dir = path.join(store.dataDir, 'snapshots');
    this.indexFile = path.join(this.dir, 'index.json');
    fs.mkdirSync(this.dir, { recursive: true });
  }

  list(): SnapshotMeta[] {
    if (!fs.existsSync(this.indexFile)) return [];
    const metas = JSON.parse(fs.readFileSync(this.indexFile, 'utf8')) as SnapshotMeta[];
    return metas.filter((m) => fs.existsSync(this.fileFor(m.id)));
  }

  private writeIndex(metas: SnapshotMeta[]) {
    const sorted = [...metas].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const tmp = `${this.indexFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(sorted, null, 2));
    fs.renameSync(tmp, this.indexFile);
  }

  private fileFor(id: string) {
    if (!/^[\w-]+$/.test(id)) throw notFound('Snapshot');
    return path.join(this.dir, `${id}.json`);
  }

  create(name: string, description: string, kind: SnapshotKind, createdBy: string): SnapshotMeta {
    const data = this.store.db;
    const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
    const meta: SnapshotMeta = {
      id,
      name: name || defaultName(kind),
      description,
      kind,
      createdAt: new Date().toISOString(),
      createdBy,
      sizeBytes: 0,
      stats: { workItems: data.workItems.length, sprints: data.sprints.length, members: data.members.length },
    };
    // Serialize the (potentially large) database once and splice it into the envelope.
    const dataJson = JSON.stringify(data);
    meta.sizeBytes = Buffer.byteLength(dataJson);
    fs.writeFileSync(this.fileFor(id), `{"format":"ado-clone-snapshot","meta":${JSON.stringify(meta)},"data":${dataJson}}`);
    this.writeIndex([meta, ...this.list()]);
    if (kind === 'auto') this.prune();
    return meta;
  }

  read(id: string): SnapshotFile {
    const file = this.fileFor(id);
    if (!fs.existsSync(file)) throw notFound('Snapshot');
    return JSON.parse(fs.readFileSync(file, 'utf8')) as SnapshotFile;
  }

  filePath(id: string) {
    const file = this.fileFor(id);
    if (!fs.existsSync(file)) throw notFound('Snapshot');
    return file;
  }

  update(id: string, changes: { name?: string; description?: string }) {
    const metas = this.list();
    const meta = metas.find((m) => m.id === id);
    if (!meta) throw notFound('Snapshot');
    Object.assign(meta, changes);
    this.writeIndex(metas);
    return meta;
  }

  delete(id: string) {
    const file = this.fileFor(id);
    if (!fs.existsSync(file)) throw notFound('Snapshot');
    fs.unlinkSync(file);
    this.writeIndex(this.list().filter((m) => m.id !== id));
  }

  /** Restore a snapshot, first saving the current state so the restore can be undone. */
  restore(id: string, user: string, origin?: string) {
    const snap = this.read(id);
    const data = normalizeDatabase(snap.data);
    const safety = this.create(`Before restoring "${snap.meta.name}"`, 'Automatic safety snapshot taken before a restore', 'pre-restore', user);
    this.store.replace(data, origin);
    return safety;
  }

  /** Import a backup file (full export or snapshot file) after taking a safety snapshot. */
  import(raw: unknown, user: string, origin?: string) {
    const data = normalizeDatabase(raw);
    const safety = this.create('Before import', 'Automatic safety snapshot taken before importing a backup', 'pre-import', user);
    this.store.replace(data, origin);
    return safety;
  }

  /** Keep only the newest `retain` automatic snapshots. */
  prune() {
    const { retain } = this.store.db.settings.backup;
    const autos = this.list().filter((m) => m.kind === 'auto');
    for (const old of autos.slice(retain)) this.delete(old.id);
  }

  /** Take an automatic snapshot if the configured interval has elapsed since the last one. */
  tick(now = Date.now()) {
    const { autoEnabled, intervalHours } = this.store.db.settings.backup;
    if (!autoEnabled) return undefined;
    const last = this.list().find((m) => m.kind === 'auto');
    if (last && now - Date.parse(last.createdAt) < intervalHours * 3_600_000) return undefined;
    return this.create('', 'Scheduled automatic backup', 'auto', 'System');
  }

  startScheduler(everyMs = 10 * 60_000) {
    this.tick();
    this.timer = setInterval(() => {
      try {
        this.tick();
      } catch (err) {
        console.error('Automatic snapshot failed', err);
      }
    }, everyMs);
    this.timer.unref();
  }

  stopScheduler() {
    if (this.timer) clearInterval(this.timer);
  }
}

function defaultName(kind: SnapshotKind) {
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  return kind === 'auto' ? `Automatic backup ${stamp} UTC` : `Snapshot ${stamp} UTC`;
}
