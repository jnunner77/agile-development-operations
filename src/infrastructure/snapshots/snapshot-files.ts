import fs from 'node:fs';
import path from 'node:path';
import type { ProjectCopy, SnapshotRepository } from '#application/backups/ports.ts';
import { Snapshot, type SnapshotId, type SnapshotKind, type SnapshotMeta } from '#domain/snapshots/snapshot.ts';

const KINDS: readonly string[] = ['manual', 'auto', 'pre-restore', 'pre-import', 'pre-reset'] satisfies SnapshotKind[];

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** An index entry as stored; entries that don't look like one are left out of the list. */
function isMeta(v: unknown): v is SnapshotMeta {
  if (!isRecord(v)) return false;
  const { id, name, description, kind, createdAt, createdBy, sizeBytes, stats } = v;
  return (
    typeof id === 'string' &&
    /^[\w-]+$/.test(id) &&
    typeof name === 'string' &&
    typeof description === 'string' &&
    typeof kind === 'string' &&
    KINDS.includes(kind) &&
    typeof createdAt === 'string' &&
    !Number.isNaN(Date.parse(createdAt)) &&
    typeof createdBy === 'string' &&
    typeof sizeBytes === 'number' &&
    isRecord(stats)
  );
}

/**
 * Snapshots as files in data/snapshots: one `<id>.json` per snapshot (`{ format, meta, data }`)
 * and an index.json of their details, newest first, so listing doesn't read every snapshot.
 */
export class FileSnapshotRepository implements SnapshotRepository {
  readonly #dir: string;
  readonly #index: string;

  constructor(dataDir: string) {
    this.#dir = path.join(dataDir, 'snapshots');
    this.#index = path.join(this.#dir, 'index.json');
    fs.mkdirSync(this.#dir, { recursive: true });
  }

  #fileFor(id: SnapshotId): string {
    return path.join(this.#dir, `${id}.json`);
  }

  #metas(): SnapshotMeta[] {
    if (!fs.existsSync(this.#index)) return [];
    const raw: unknown = JSON.parse(fs.readFileSync(this.#index, 'utf8'));
    if (!Array.isArray(raw)) return [];
    return raw.filter(isMeta).filter((m) => fs.existsSync(this.#fileFor(m.id as SnapshotId)));
  }

  #writeIndex(metas: SnapshotMeta[]): void {
    const sorted = [...metas].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const tmp = `${this.#index}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(sorted, null, 2));
    fs.renameSync(tmp, this.#index);
  }

  async all(): Promise<Snapshot[]> {
    return this.#metas().map((m) => Snapshot.reconstitute(m));
  }

  async find(id: SnapshotId): Promise<Snapshot | undefined> {
    const meta = this.#metas().find((m) => m.id === id);
    return meta ? Snapshot.reconstitute(meta) : undefined;
  }

  async add(snapshot: Snapshot, copy: ProjectCopy): Promise<void> {
    const meta = snapshot.toMeta();
    // The project is serialized once and spliced into the envelope.
    fs.writeFileSync(this.#fileFor(snapshot.id), `{"format":"ado-clone-snapshot","meta":${JSON.stringify(meta)},"data":${copy.json}}`);
    this.#writeIndex([meta, ...this.#metas().filter((m) => m.id !== meta.id)]);
  }

  async update(snapshot: Snapshot): Promise<void> {
    const meta = snapshot.toMeta();
    this.#writeIndex(this.#metas().map((m) => (m.id === meta.id ? meta : m)));
  }

  async delete(id: SnapshotId): Promise<void> {
    fs.rmSync(this.#fileFor(id), { force: true });
    this.#writeIndex(this.#metas().filter((m) => m.id !== id));
  }

  async data(id: SnapshotId): Promise<{ readonly data: unknown } | undefined> {
    const file = this.#fileFor(id);
    if (!fs.existsSync(file)) return undefined;
    const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { data: isRecord(raw) ? raw['data'] : undefined };
  }

  async file(id: SnapshotId): Promise<AsyncIterable<Uint8Array> | undefined> {
    const file = this.#fileFor(id);
    return fs.existsSync(file) ? fs.createReadStream(file) : undefined;
  }
}
