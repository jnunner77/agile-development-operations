import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  DEFAULT_AUTH_SETTINGS,
  EXPIRY_DAYS_MAX,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  SESSION_TIMEOUT_MAX,
  SESSION_TIMEOUT_MIN,
  type AccountSummary,
  type AuthAdminView,
  type AuthSettings,
  type AuthStatus,
  type AuthUser,
  type LoginResult,
} from '../shared/auth';
import type { Database, Member } from '../shared/types';
import { HttpError, badRequest, notFound } from './errors';
import type { Store } from './store';

// ---- Password hashing -----------------------------------------------------------
// Passwords are never stored or recoverable. Each one is run through scrypt (a slow,
// memory-hard one-way function) with its own random salt, and only the result is kept.

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 };

function scrypt(password: string, salt: Buffer, params: { N: number; r: number; p: number; keylen: number }): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    crypto.scrypt(password.normalize('NFKC'), salt, params.keylen, { N: params.N, r: params.r, p: params.p, maxmem: SCRYPT.maxmem }, (err, key) =>
      err ? reject(err) : resolve(key),
    ),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, saltB64, keyB64] = stored.split('$');
  if (alg !== 'scrypt' || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, 'base64');
  const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), { N: Number(n), r: Number(r), p: Number(p), keylen: expected.length });
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

// Unknown usernames are checked against this so a wrong username takes as long as a wrong password.
let dummyHash: Promise<string> | null = null;
const getDummyHash = () => (dummyHash ??= hashPassword(crypto.randomBytes(16).toString('hex')));

// ---- Stored data ----------------------------------------------------------------

interface Account {
  isAdmin: boolean;
  passwordHash: string | null;
  passwordSetAt: string | null;
  mustChange: boolean;
}

interface AuthFile {
  settings: AuthSettings;
  /** Keyed by team member id. Kept outside db.json so it never reaches browsers, snapshots or exports. */
  accounts: Record<string, Account>;
}

const blankAccount = (): Account => ({ isAdmin: false, passwordHash: null, passwordSetAt: null, mustChange: false });

export const SESSION_COOKIE = 'boards_session';
const MAX_FAILURES = 5;
const LOCK_MS = 5 * 60_000;
const DAY_MS = 86_400_000;

const invalidLogin = () => new HttpError(401, 'Incorrect username or password');

export const authSettingsSchema = z
  .object({
    enabled: z.boolean(),
    passwordExpiryDays: z.number().int().min(0).max(EXPIRY_DAYS_MAX, `Password expiry can be at most ${EXPIRY_DAYS_MAX} days`),
    sessionTimeoutMinutes: z
      .number()
      .int()
      .min(SESSION_TIMEOUT_MIN, `Session timeout must be at least ${SESSION_TIMEOUT_MIN} minutes`)
      .max(SESSION_TIMEOUT_MAX, 'Session timeout can be at most 7 days'),
  })
  .partial()
  .strict();

const password = z.string().max(PASSWORD_MAX_LENGTH, `Passwords can be at most ${PASSWORD_MAX_LENGTH} characters`);
const loginSchema = z.object({ username: z.string().trim().min(1, 'Enter your username').max(64), password: password.default('') }).strict();
const changeSchema = z.object({ username: z.string().trim().min(1, 'Enter your username').max(64), currentPassword: password.optional(), newPassword: password }).strict();
const adminPasswordSchema = z.object({ password, mustChange: z.boolean().default(true) }).strict();
const adminAccountSchema = z.object({ isAdmin: z.boolean() }).strict();

export interface AuthOptions {
  /** Force sign-in off regardless of the saved setting (recovery if every admin is locked out). */
  disabled?: boolean;
  now?: () => number;
}

export class AuthManager {
  private data: AuthFile;
  private readonly file: string;
  private readonly sessions = new Map<string, { memberId: string; lastSeen: number }>();
  private readonly failures = new Map<string, { count: number; lockedUntil: number }>();
  readonly overridden: boolean;
  private readonly now: () => number;

  constructor(
    private readonly store: Store,
    opts: AuthOptions = {},
  ) {
    this.file = path.join(store.dataDir, 'auth.json');
    this.overridden = !!opts.disabled;
    this.now = opts.now ?? Date.now;
    this.data = { settings: { ...DEFAULT_AUTH_SETTINGS }, accounts: {} };
    if (fs.existsSync(this.file)) {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<AuthFile>;
      this.data = { settings: { ...DEFAULT_AUTH_SETTINGS, ...raw.settings }, accounts: raw.accounts ?? {} };
    }
    store.addGuard((db) => this.checkDatabase(db));
  }

  get enabled() {
    return this.data.settings.enabled && !this.overridden;
  }

  get settings(): AuthSettings {
    return { ...this.data.settings };
  }

  private save() {
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  private account(memberId: string): Account {
    return this.data.accounts[memberId] ?? blankAccount();
  }

  private putAccount(memberId: string, account: Account) {
    this.data.accounts[memberId] = account;
    this.save();
  }

  private findMember(username: string): Member | undefined {
    const u = username.trim().toLowerCase();
    return this.store.db.members.find((m) => m.active && m.username && m.username.toLowerCase() === u);
  }

  private expiresAt(account: Account): number | null {
    const days = this.data.settings.passwordExpiryDays;
    if (!days || !account.passwordSetAt) return null;
    return Date.parse(account.passwordSetAt) + days * DAY_MS;
  }

  private isExpired(account: Account) {
    const at = this.expiresAt(account);
    return at != null && this.now() >= at;
  }

  private hasUsableAdmin(members: Member[], accounts: Record<string, Account> = this.data.accounts) {
    return members.some((m) => m.active && !!m.username && !!accounts[m.id]?.isAdmin);
  }

  /** Store guard: with sign-in on, some active administrator with a username must always remain. */
  private checkDatabase(db: Database) {
    if (this.enabled && !this.hasUsableAdmin(db.members)) {
      throw badRequest('Sign-in is turned on, so at least one active administrator with a username must remain. Make someone else an administrator first, or turn sign-in off.');
    }
  }

  // ---- Failed attempt tracking ----

  private assertNotLocked(key: string) {
    const f = this.failures.get(key);
    const now = this.now();
    if (f && f.lockedUntil > now) {
      const mins = Math.ceil((f.lockedUntil - now) / 60_000);
      throw new HttpError(429, `Too many failed sign-in attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`);
    }
  }

  private recordFailure(key: string) {
    const now = this.now();
    const f = this.failures.get(key) ?? { count: 0, lockedUntil: 0 };
    if (f.lockedUntil && f.lockedUntil <= now) Object.assign(f, { count: 0, lockedUntil: 0 });
    f.count++;
    if (f.count >= MAX_FAILURES) Object.assign(f, { count: 0, lockedUntil: now + LOCK_MS });
    this.failures.set(key, f);
  }

  private lockedUntil(member: Member): string | null {
    const f = member.username ? this.failures.get(member.username.toLowerCase()) : undefined;
    return f && f.lockedUntil > this.now() ? new Date(f.lockedUntil).toISOString() : null;
  }

  // ---- Sessions ----

  private createSession(memberId: string) {
    this.sweepSessions();
    const token = crypto.randomBytes(32).toString('base64url');
    this.sessions.set(token, { memberId, lastSeen: this.now() });
    return token;
  }

  private sweepSessions() {
    const limit = this.data.settings.sessionTimeoutMinutes * 60_000;
    const now = this.now();
    for (const [token, s] of this.sessions) if (now - s.lastSeen > limit) this.sessions.delete(token);
  }

  private revokeSessions(memberId: string) {
    for (const [token, s] of this.sessions) if (s.memberId === memberId) this.sessions.delete(token);
  }

  /** The member a session belongs to, or null if it has timed out or is no longer valid. */
  resolve(token: string, touch = true): Member | null {
    const s = this.sessions.get(token);
    if (!s) return null;
    const now = this.now();
    const member = this.store.db.members.find((m) => m.id === s.memberId);
    const account = this.account(s.memberId);
    const valid =
      now - s.lastSeen <= this.data.settings.sessionTimeoutMinutes * 60_000 &&
      member?.active &&
      !!member.username &&
      !!account.passwordHash &&
      !account.mustChange &&
      !this.isExpired(account);
    if (!valid) {
      this.sessions.delete(token);
      return null;
    }
    if (touch) s.lastSeen = now;
    return member ?? null;
  }

  logout(token: string) {
    this.sessions.delete(token);
  }

  // ---- Views ----

  private userView(member: Member): AuthUser {
    const at = this.expiresAt(this.account(member.id));
    return { memberId: member.id, name: member.name, username: member.username, isAdmin: this.account(member.id).isAdmin, passwordExpiresAt: at == null ? null : new Date(at).toISOString() };
  }

  status(member: Member | null): AuthStatus {
    return {
      enabled: this.enabled,
      overridden: this.overridden,
      user: this.enabled && member ? this.userView(member) : null,
      settings: this.settings,
      passwordMinLength: PASSWORD_MIN_LENGTH,
    };
  }

  adminView(): AuthAdminView {
    const accounts: AccountSummary[] = this.store.db.members.map((m) => {
      const a = this.account(m.id);
      const at = this.expiresAt(a);
      return {
        memberId: m.id,
        isAdmin: a.isAdmin,
        hasPassword: !!a.passwordHash,
        passwordSetAt: a.passwordSetAt,
        passwordExpiresAt: at == null ? null : new Date(at).toISOString(),
        expired: this.isExpired(a),
        mustChange: a.mustChange,
        lockedUntil: this.lockedUntil(m),
      };
    });
    return { settings: this.settings, overridden: this.overridden, accounts };
  }

  isAdmin(member: Member | null) {
    return !!member && this.account(member.id).isAdmin;
  }

  // ---- Sign-in flows ----

  private validateNewPassword(pw: string, member: Member) {
    if (pw.length < PASSWORD_MIN_LENGTH) throw badRequest(`Passwords must be at least ${PASSWORD_MIN_LENGTH} characters`);
    if (member.username && pw.toLowerCase() === member.username.toLowerCase()) throw badRequest("A password can't be the same as the username");
  }

  async login(username: string, pw: string): Promise<{ result: LoginResult; token?: string }> {
    if (!this.enabled) throw badRequest('Sign-in is not turned on');
    const key = username.trim().toLowerCase();
    this.assertNotLocked(key);
    const member = this.findMember(username);
    if (!member) {
      await verifyPassword(pw, await getDummyHash());
      this.recordFailure(key);
      throw invalidLogin();
    }
    const account = this.account(member.id);
    if (!account.passwordHash) return { result: { status: 'setup' } };
    if (!(await verifyPassword(pw, account.passwordHash))) {
      this.recordFailure(key);
      throw invalidLogin();
    }
    this.failures.delete(key);
    if (account.mustChange) return { result: { status: 'change', reason: 'temporary' } };
    if (this.isExpired(account)) return { result: { status: 'change', reason: 'expired' } };
    return { result: { status: 'ok', user: this.userView(member) }, token: this.createSession(member.id) };
  }

  /**
   * Set a new password and sign in. Covers first-time setup (no password yet, so no
   * current password is needed), expired and temporary passwords, and voluntary changes.
   */
  async changePassword(username: string, currentPassword: string | undefined, newPassword: string): Promise<{ user: AuthUser; token: string }> {
    if (!this.enabled) throw badRequest('Sign-in is not turned on');
    const key = username.trim().toLowerCase();
    this.assertNotLocked(key);
    const member = this.findMember(username);
    if (!member) {
      await verifyPassword(newPassword, await getDummyHash());
      this.recordFailure(key);
      throw invalidLogin();
    }
    this.validateNewPassword(newPassword, member);
    const before = this.account(member.id).passwordHash;
    if (before) {
      if (!currentPassword || !(await verifyPassword(currentPassword, before))) {
        this.recordFailure(key);
        throw new HttpError(401, 'Current password is incorrect');
      }
      if (await verifyPassword(newPassword, before)) throw badRequest('Choose a password different from the current one');
    }
    const hash = await hashPassword(newPassword);
    // Another request may have set the password while we were hashing (e.g. two first-time setups).
    const account = this.account(member.id);
    if (account.passwordHash !== before) throw new HttpError(409, 'The password was just changed. Sign in again.');
    this.failures.delete(key);
    this.putAccount(member.id, { ...account, passwordHash: hash, passwordSetAt: new Date(this.now()).toISOString(), mustChange: false });
    this.revokeSessions(member.id);
    return { user: this.userView(member), token: this.createSession(member.id) };
  }

  // ---- Administration ----

  private member(memberId: string) {
    const m = this.store.db.members.find((x) => x.id === memberId);
    if (!m) throw notFound('Team member');
    return m;
  }

  updateSettings(patch: z.infer<typeof authSettingsSchema>) {
    const next = { ...this.data.settings, ...patch };
    if (next.enabled && !this.overridden && !this.hasUsableAdmin(this.store.db.members)) {
      throw badRequest('Before turning on sign-in, make at least one active team member with a username an administrator.');
    }
    this.data.settings = next;
    this.save();
  }

  setAdmin(memberId: string, isAdmin: boolean) {
    this.member(memberId);
    const account = { ...this.account(memberId), isAdmin };
    if (this.enabled && !this.hasUsableAdmin(this.store.db.members, { ...this.data.accounts, [memberId]: account })) {
      throw badRequest('At least one active administrator with a username must remain while sign-in is on.');
    }
    this.putAccount(memberId, account);
  }

  async setPasswordFor(memberId: string, pw: string, mustChange: boolean) {
    const member = this.member(memberId);
    if (!member.username) throw badRequest(`Give ${member.name} a username in Team members first`);
    this.validateNewPassword(pw, member);
    const hash = await hashPassword(pw);
    this.putAccount(memberId, { ...this.account(memberId), passwordHash: hash, passwordSetAt: new Date(this.now()).toISOString(), mustChange });
    this.failures.delete(member.username.toLowerCase());
    this.revokeSessions(memberId);
  }

  /** Clear someone's password so they choose a new one the next time they sign in. */
  resetPassword(memberId: string) {
    const member = this.member(memberId);
    this.putAccount(memberId, { ...this.account(memberId), passwordHash: null, passwordSetAt: null, mustChange: false });
    if (member.username) this.failures.delete(member.username.toLowerCase());
    this.revokeSessions(memberId);
  }

  // ---- Express glue ----

  /**
   * Runs before every /api route. With sign-in on it rejects requests without a valid
   * session and replaces the client-supplied X-User header with the signed-in member,
   * so history and comments are attributed to who actually made the change.
   */
  authenticate = (req: Request, res: Response, next: NextFunction) => {
    const token = readCookie(req, SESSION_COOKIE);
    const member = token ? this.resolve(token) : null;
    res.locals.authMember = member;
    res.locals.authToken = member ? token : undefined;
    if (!this.enabled) return next();
    if (member) req.headers['x-user'] = encodeURIComponent(member.id);
    else delete req.headers['x-user'];
    if (PUBLIC_PATHS.has(req.path)) return next();
    if (!member) return res.status(401).json({ error: 'Please sign in', code: 'signin' });
    next();
  };

  /** Restrict a route to administrators while sign-in is on. With sign-in off anyone may use it. */
  requireAdmin = (_req: Request, res: Response, next: NextFunction) => {
    if (this.enabled && !this.isAdmin(res.locals.authMember ?? null)) throw new HttpError(403, 'Only administrators can do this');
    next();
  };

  routes() {
    const r = express.Router();
    r.get('/status', (_req, res) => {
      res.json(this.status(res.locals.authMember ?? null));
    });
    r.post('/login', async (req, res) => {
      const input = loginSchema.parse(req.body);
      const { result, token } = await this.login(input.username, input.password);
      if (token) setSessionCookie(req, res, token);
      res.json(result);
    });
    r.post('/password', async (req, res) => {
      const input = changeSchema.parse(req.body);
      const { user, token } = await this.changePassword(input.username, input.currentPassword, input.newPassword);
      setSessionCookie(req, res, token);
      res.json({ status: 'ok', user } satisfies LoginResult);
    });
    r.post('/logout', (req, res) => {
      const token = readCookie(req, SESSION_COOKIE);
      if (token) this.logout(token);
      res.clearCookie(SESSION_COOKIE, { path: '/' });
      res.status(204).end();
    });
    r.get('/admin', this.requireAdmin, (_req, res) => {
      res.json(this.adminView());
    });
    r.put('/settings', this.requireAdmin, (req, res) => {
      this.updateSettings(authSettingsSchema.parse(req.body));
      res.json(this.adminView());
    });
    r.patch('/accounts/:memberId', this.requireAdmin, (req, res) => {
      this.setAdmin(String(req.params.memberId), adminAccountSchema.parse(req.body).isAdmin);
      res.json(this.adminView());
    });
    r.post('/accounts/:memberId/password', this.requireAdmin, async (req, res) => {
      const input = adminPasswordSchema.parse(req.body);
      await this.setPasswordFor(String(req.params.memberId), input.password, input.mustChange);
      res.json(this.adminView());
    });
    r.post('/accounts/:memberId/reset', this.requireAdmin, (req, res) => {
      this.resetPassword(String(req.params.memberId));
      res.json(this.adminView());
    });
    return r;
  }
}

const PUBLIC_PATHS = new Set(['/auth/status', '/auth/login', '/auth/password', '/auth/logout']);

function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

function setSessionCookie(req: Request, res: Response, token: string) {
  // HttpOnly keeps the token away from page scripts; SameSite=Strict blocks cross-site use.
  res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'strict', secure: req.secure, path: '/' });
}
