import fs from 'node:fs';
import path from 'node:path';
import type { Database, Delta } from '#application/contracts/database.ts';
import { err, ok, type Result } from '#shared/result.ts';
import { emptyDatabase, normalizeDatabase } from './schema.ts';
import { SerialQueue } from '../serial-writes.ts';

/** A store guard refused a change; the HTTP layer answers 400 with the message. */
export class RejectedChangeError extends Error {}

/** A record a mutation looked up doesn't exist. The HTTP layer answers 404 "<what> not found". */
export class MissingRecordError extends Error {
  readonly what: string;

  constructor(what: string) {
    super(`${what} not found`);
    this.what = what;
  }
}

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
  readonly db: Database;
  /** Display name of the user making the change. */
  readonly user: string;

  constructor(db: Database, user: string) {
    this.db = db;
    this.user = user;
  }

  item(id: number) {
    const item = this.db.workItems.find((w) => w.id === id);
    if (!item) throw new MissingRecordError(`Work item ${id}`);
    return item;
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
  readonly dataDir: string;
  private readonly file: string;
  private readonly listeners = new Set<DeltaListener>();
  private readonly guards: ((db: Database) => void)[] = [];
  /** Database commits and sign-in safeguards share one serialization boundary. */
  readonly writes = new SerialQueue();

  constructor(dataDir: string, init: () => Database = () => emptyDatabase()) {
    this.dataDir = dataDir;
    fs.mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, 'db.json');
    if (fs.existsSync(this.file)) {
      this.db = normalizeDatabase(JSON.parse(fs.readFileSync(this.file, 'utf8')));
    } else {
      this.db = init();
      this.save();
    }
  }

  /** Atomic write: write a temp file then rename over the original. Throws if it can't. */
  save(db: Database = this.db) {
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(db));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      throw err;
    }
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
    const tx = new Tx(structuredClone(this.db), user);
    const result = fn(tx);
    return { delta: this.commit(tx, origin), result };
  }

  /** A synchronous mutation run in the shared database/authentication write queue. */
  transactSerial<T>(user: string, origin: string | undefined, fn: (tx: Tx) => T): Promise<{ delta: Delta; result: T }> {
    return this.writes.run(async () => this.transact(user, origin, fn));
  }

  /**
   * Run asynchronous work against a working copy, one transaction at a time. The copy is
   * committed, persisted and broadcast only if the work returns ok; on an error result or a
   * throw the live database is left untouched.
   */
  transactAsync<T, E>(
    user: string,
    origin: string | undefined,
    work: (tx: Tx) => Promise<Result<T, E>>,
  ): Promise<Result<{ result: T; delta: Delta }, E>> {
    const run = async (): Promise<Result<{ result: T; delta: Delta }, E>> => {
      const base = this.db;
      const tx = new Tx(structuredClone(base), user);
      const result = await work(tx);
      if (!result.ok) return err(result.error);
      // A synchronous transaction slipping in between would be overwritten; refuse instead.
      if (this.db !== base) throw new Error('The database changed while an asynchronous transaction was running');
      return ok({ result: result.value, delta: this.commit(tx, origin) });
    };
    return this.writes.run(run);
  }

  private commit(tx: Tx, origin: string | undefined): Delta {
    const working = tx.db;
    if (tx.members.size || tx.deletedMembers.size) this.check(working);
    working.version = this.db.version + 1;
    // On disk first: if the write fails, the live database and browsers are left as they were.
    this.save(working);
    this.db = working;
    const delta = tx.toDelta();
    this.emit(delta, origin);
    return delta;
  }

  /** Replace the entire database (restore / import / reset). */
  replace(db: Database, origin?: string): Delta {
    const next = normalizeDatabase(db);
    this.check(next);
    next.version = this.db.version + 1;
    this.save(next);
    this.db = next;
    const delta: Delta = { version: next.version, reset: true };
    this.emit(delta, origin);
    return delta;
  }

}
