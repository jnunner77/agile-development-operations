import fs from 'node:fs';
import path from 'node:path';
import type { Database, Delta } from '../shared/types';
import { notFound } from './errors';
import { emptyDatabase, normalizeDatabase } from './schema';

/**
 * Tracks which entities a mutation touched so the change can be sent to clients as
 * a small delta instead of the whole database.
 */
export class Tx {
  readonly items = new Set<number>();
  readonly deletedItems = new Set<number>();
  readonly links = new Set<string>();
  readonly deletedLinks = new Set<string>();
  readonly sprints = new Set<string>();
  readonly deletedSprints = new Set<string>();
  readonly members = new Set<string>();
  readonly deletedMembers = new Set<string>();
  readonly capacities = new Set<string>();
  settings = false;
  recycleBin = false;
  readonly now = new Date().toISOString();

  constructor(
    readonly db: Database,
    /** Display name of the user making the change. */
    readonly user: string,
  ) {}

  item(id: number) {
    const item = this.db.workItems.find((w) => w.id === id);
    if (!item) throw notFound(`Work item ${id}`);
    return item;
  }

  sprint(id: string) {
    const sprint = this.db.sprints.find((s) => s.id === id);
    if (!sprint) throw notFound('Sprint');
    return sprint;
  }

  member(id: string) {
    const member = this.db.members.find((m) => m.id === id);
    if (!member) throw notFound('Team member');
    return member;
  }

  touchItem(id: number) {
    this.items.add(id);
  }

  touchLink(id: string) {
    this.links.add(id);
  }

  toDelta(): Delta {
    const { db } = this;
    const delta: Delta = { version: db.version };
    const liveItems = [...this.items].filter((id) => !this.deletedItems.has(id));
    if (liveItems.length) delta.workItems = db.workItems.filter((w) => liveItems.includes(w.id));
    if (this.deletedItems.size) delta.deletedWorkItemIds = [...this.deletedItems];
    const liveLinks = [...this.links].filter((id) => !this.deletedLinks.has(id));
    if (liveLinks.length) delta.links = db.links.filter((l) => liveLinks.includes(l.id));
    if (this.deletedLinks.size) delta.deletedLinkIds = [...this.deletedLinks];
    if (this.sprints.size) delta.sprints = db.sprints.filter((s) => this.sprints.has(s.id));
    if (this.deletedSprints.size) delta.deletedSprintIds = [...this.deletedSprints];
    if (this.members.size) delta.members = db.members.filter((m) => this.members.has(m.id));
    if (this.deletedMembers.size) delta.deletedMemberIds = [...this.deletedMembers];
    if (this.capacities.size) delta.capacities = db.capacities.filter((c) => this.capacities.has(c.sprintId));
    if (this.settings) delta.settings = db.settings;
    if (this.recycleBin) delta.recycleBin = db.recycleBin;
    return delta;
  }
}

export type DeltaListener = (delta: Delta, origin: string | undefined) => void;

export class Store {
  db: Database;
  private readonly file: string;
  private readonly listeners = new Set<DeltaListener>();
  private readonly guards: ((db: Database) => void)[] = [];

  constructor(
    readonly dataDir: string,
    init: () => Database = () => emptyDatabase(),
  ) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, 'db.json');
    if (fs.existsSync(this.file)) {
      this.db = normalizeDatabase(JSON.parse(fs.readFileSync(this.file, 'utf8')));
    } else {
      this.db = init();
      this.save();
    }
  }

  /** Atomic write: write a temp file then rename over the original. */
  save() {
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.db));
    fs.renameSync(tmp, this.file);
  }

  /** Register a check that throws if a database state must not be committed. */
  addGuard(guard: (db: Database) => void) {
    this.guards.push(guard);
  }

  /** Throw if committing `db` would break an invariant (e.g. lock every administrator out). */
  check(db: Database) {
    for (const guard of this.guards) guard(db);
  }

  subscribe(listener: DeltaListener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(delta: Delta, origin?: string) {
    for (const l of this.listeners) l(delta, origin);
  }

  /**
   * Run a mutation against a working copy. If it throws, the live database is left
   * untouched; otherwise the copy is committed, persisted and broadcast.
   */
  transact<T>(user: string, origin: string | undefined, fn: (tx: Tx) => T): { delta: Delta; result: T } {
    const working = structuredClone(this.db);
    const tx = new Tx(working, user);
    const result = fn(tx);
    if (tx.members.size || tx.deletedMembers.size) this.check(working);
    working.version = this.db.version + 1;
    this.db = working;
    this.save();
    const delta = tx.toDelta();
    this.emit(delta, origin);
    return { delta, result };
  }

  /** Replace the entire database (restore / import / reset). */
  replace(db: Database, origin?: string): Delta {
    const next = normalizeDatabase(db);
    this.check(next);
    next.version = this.db.version + 1;
    this.db = next;
    this.save();
    const delta: Delta = { version: next.version, reset: true };
    this.emit(delta, origin);
    return delta;
  }
}
