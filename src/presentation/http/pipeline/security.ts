import type { ServerResponse } from 'node:http';

// Defensive checks for running on the open internet: rate limits, temporary bans for abusive
// clients, a cap on concurrent password hashing, cross-site request checks and live-connection
// caps. Everything is in memory, so it resets when the server restarts. Each check returns a
// refusal for the pipeline to send, or null to let the request through.

/** Token bucket: `burst` requests at once, refilling to allow `perMinute` on average. */
export interface Limit {
  burst: number;
  perMinute: number;
}

export interface SecurityOptions {
  /** Every request (API and static files) per client IP. */
  ip: Limit;
  /** API requests without a signed-in user, per IP (only while sign-in is on). */
  anonymous: Limit;
  /** API requests per signed-in user (or per IP while sign-in is off). */
  user: Limit;
  /** Changes (POST/PUT/PATCH/DELETE) per signed-in user (or per IP while sign-in is off). */
  mutations: Limit;
  /** Sign-in and password attempts per IP. */
  signIn: Limit;
  /** Expensive admin operations (export, import, snapshots, reset) per user. */
  heavy: Limit;
  /** Live-update connections open at once. */
  streamsPerUser: number;
  streamsPerIp: number;
  streamsTotal: number;
  /** Password checks running at once across all clients (each uses ~16 MB and real CPU). */
  hashConcurrency: number;
  /** Temporary bans: an IP that trips limits this often in the window is blocked. */
  ban: { violations: number; authFailures: number; notFound: number; windowMs: number; durationMs: number };
  /** Upper bound on tracked clients per limiter, so the tables can't grow without limit. */
  maxTrackedKeys: number;
  /** Trusted client addresses (exact IPs or IPv4 CIDR ranges) that are never limited or blocked. */
  allowlist: string[];
}

export const DEFAULT_SECURITY: SecurityOptions = {
  ip: { burst: 300, perMinute: 900 },
  anonymous: { burst: 30, perMinute: 60 },
  user: { burst: 200, perMinute: 600 },
  mutations: { burst: 100, perMinute: 240 },
  signIn: { burst: 5, perMinute: 5 },
  heavy: { burst: 5, perMinute: 1 },
  streamsPerUser: 10,
  streamsPerIp: 50,
  streamsTotal: 500,
  hashConcurrency: 4,
  ban: { violations: 60, authFailures: 20, notFound: 120, windowMs: 10 * 60_000, durationMs: 60 * 60_000 },
  maxTrackedKeys: 50_000,
  allowlist: [],
};

/** Why a request is turned away, and how the answer says so. */
export interface Refusal {
  readonly status: number;
  readonly message: string;
  /** Seconds, for a Retry-After header. */
  readonly retryAfter?: number;
  /** Close the connection after answering (for blocked clients). */
  readonly close?: boolean;
}

/** The member a request comes from, as far as limits are concerned. */
export interface LimitedMember {
  readonly id: string;
}

function ipv4ToInt(ip: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const [a = 0, b = 0, c = 0, d = 0] = m.slice(1).map(Number);
  if ([a, b, c, d].some((p) => p > 255)) return null;
  return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
}

/** Build a matcher for exact addresses and IPv4 CIDR ranges ("203.0.113.0/24"). */
export function ipMatcher(entries: string[]): (ip: string) => boolean {
  const exact = new Set<string>();
  const ranges: { base: number; mask: number }[] = [];
  for (const raw of entries.map((e) => e.trim()).filter(Boolean)) {
    const [addr = '', bits] = raw.split('/');
    const base = ipv4ToInt(addr);
    if (bits !== undefined && base !== null && /^\d+$/.test(bits) && Number(bits) <= 32) {
      const mask = Number(bits) === 0 ? 0 : (~0 << (32 - Number(bits))) >>> 0;
      ranges.push({ base: (base & mask) >>> 0, mask });
    } else {
      exact.add(raw.toLowerCase());
    }
  }
  return (ip: string) => {
    const plain = ip.toLowerCase().replace(/^::ffff:/, '');
    if (exact.has(ip.toLowerCase()) || exact.has(plain)) return true;
    const n = ipv4ToInt(plain);
    return n !== null && ranges.some((r) => ((n & r.mask) >>> 0) === r.base);
  };
}

export class TokenBucket {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  private readonly limit: Limit;
  private readonly maxKeys: number;
  private readonly now: () => number;

  constructor(limit: Limit, maxKeys: number, now: () => number) {
    this.limit = limit;
    this.maxKeys = maxKeys;
    this.now = now;
  }

  /** Try to spend one token; returns milliseconds to wait when the bucket is empty. */
  take(key: string): { ok: true } | { ok: false; retryAfterMs: number } {
    const now = this.now();
    const ratePerMs = this.limit.perMinute / 60_000;
    let b = this.buckets.get(key);
    if (b) {
      b.tokens = Math.min(this.limit.burst, b.tokens + (now - b.at) * ratePerMs);
      b.at = now;
      // Re-insert so Map order approximates least-recently-used for eviction.
      this.buckets.delete(key);
    } else {
      b = { tokens: this.limit.burst, at: now };
      if (this.buckets.size >= this.maxKeys) this.evict();
    }
    this.buckets.set(key, b);
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return { ok: true };
    }
    return { ok: false, retryAfterMs: Math.ceil((1 - b.tokens) / ratePerMs) };
  }

  /** Drop full buckets (they carry no state) and, if still too big, the least recently used. */
  sweep() {
    const now = this.now();
    const ratePerMs = this.limit.perMinute / 60_000;
    for (const [key, b] of this.buckets) {
      if (b.tokens + (now - b.at) * ratePerMs >= this.limit.burst) this.buckets.delete(key);
    }
  }

  private evict() {
    this.sweep();
    const excess = this.buckets.size - Math.floor(this.maxKeys * 0.9);
    if (excess <= 0) return;
    let n = 0;
    for (const key of this.buckets.keys()) {
      if (n++ >= excess) break;
      this.buckets.delete(key);
    }
  }

  get size() {
    return this.buckets.size;
  }
}

/** Counts events per key within a sliding window. */
class EventCounter {
  private readonly events = new Map<string, number[]>();

  private readonly windowMs: number;
  private readonly maxKeys: number;
  private readonly now: () => number;

  constructor(windowMs: number, maxKeys: number, now: () => number) {
    this.windowMs = windowMs;
    this.maxKeys = maxKeys;
    this.now = now;
  }

  add(key: string): number {
    const now = this.now();
    const list = (this.events.get(key) ?? []).filter((t) => now - t < this.windowMs);
    list.push(now);
    this.events.delete(key);
    if (this.events.size >= this.maxKeys) {
      const oldest = this.events.keys().next();
      if (!oldest.done) this.events.delete(oldest.value);
    }
    this.events.set(key, list);
    return list.length;
  }

  clear(key: string) {
    this.events.delete(key);
  }

  sweep() {
    const now = this.now();
    for (const [key, list] of this.events) if (!list.some((t) => now - t < this.windowMs)) this.events.delete(key);
  }
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/** Paths where a 401 means someone presented bad credentials (password or webhook signature). */
const SIGN_IN_PATHS = new Set(['/api/auth/login', '/api/auth/password', '/api/integrations/github/webhook']);

function tooMany(retryAfterMs: number, what = 'requests'): Refusal {
  const secs = Math.max(1, Math.ceil(retryAfterMs / 1000));
  return { status: 429, message: `Too many ${what}. Try again in ${secs} second${secs === 1 ? '' : 's'}.`, retryAfter: secs };
}

const CROSS_SITE: Refusal = { status: 403, message: 'Cross-site requests are not allowed' };

export class Security {
  readonly options: SecurityOptions;
  private readonly now: () => number;
  private readonly ipBucket: TokenBucket;
  private readonly anonBucket: TokenBucket;
  private readonly userBucket: TokenBucket;
  private readonly mutationBucket: TokenBucket;
  private readonly signInBucket: TokenBucket;
  private readonly heavyBucket: TokenBucket;
  private readonly violations: EventCounter;
  private readonly authFailures: EventCounter;
  private readonly notFounds: EventCounter;
  private readonly bans = new Map<string, number>();
  private readonly streams = new Map<string, number>();
  private streamsOpen = 0;
  private hashing = 0;
  private timer: NodeJS.Timeout | undefined;
  private readonly trusted: (ip: string) => boolean;

  constructor(options: Partial<SecurityOptions> = {}, now: () => number = Date.now) {
    this.options = { ...DEFAULT_SECURITY, ...options, ban: { ...DEFAULT_SECURITY.ban, ...options.ban } };
    this.now = now;
    const o = this.options;
    const bucket = (l: Limit) => new TokenBucket(l, o.maxTrackedKeys, now);
    this.ipBucket = bucket(o.ip);
    this.anonBucket = bucket(o.anonymous);
    this.userBucket = bucket(o.user);
    this.mutationBucket = bucket(o.mutations);
    this.signInBucket = bucket(o.signIn);
    this.heavyBucket = bucket(o.heavy);
    this.violations = new EventCounter(o.ban.windowMs, o.maxTrackedKeys, now);
    this.authFailures = new EventCounter(o.ban.windowMs, o.maxTrackedKeys, now);
    this.notFounds = new EventCounter(o.ban.windowMs, o.maxTrackedKeys, now);
    this.trusted = ipMatcher(o.allowlist);
  }

  /** Periodically drop idle state. */
  start(everyMs = 60_000) {
    this.timer = setInterval(() => this.sweep(), everyMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  sweep() {
    for (const b of [this.ipBucket, this.anonBucket, this.userBucket, this.mutationBucket, this.signInBucket, this.heavyBucket]) b.sweep();
    for (const c of [this.violations, this.authFailures, this.notFounds]) c.sweep();
    const now = this.now();
    for (const [ip, until] of this.bans) if (until <= now) this.bans.delete(ip);
  }

  isBanned(ip: string) {
    const until = this.bans.get(ip);
    if (!until) return false;
    if (until <= this.now()) {
      this.bans.delete(ip);
      return false;
    }
    return true;
  }

  private ban(ip: string, reason: string) {
    if (this.isBanned(ip)) return;
    const until = this.now() + this.options.ban.durationMs;
    this.bans.set(ip, until);
    console.warn(`[security] blocked ${ip} until ${new Date(until).toISOString()}: ${reason}`);
  }

  private count(counter: EventCounter, ip: string, threshold: number, reason: string) {
    if (this.trusted(ip)) return;
    if (counter.add(ip) >= threshold) {
      counter.clear(ip);
      this.ban(ip, reason);
    }
  }

  private check(bucket: TokenBucket, key: string, ip: string, what?: string): Refusal | null {
    if (this.trusted(ip)) return null;
    const r = bucket.take(key);
    if (r.ok) return null;
    this.count(this.violations, ip, this.options.ban.violations, 'repeatedly exceeded rate limits');
    return tooMany(r.retryAfterMs, what);
  }

  /**
   * First check for every request: turns away banned clients and applies the per-IP limit (the
   * health check is exempt). `path` is the request path, without the query string.
   */
  admit(ip: string, path: string): Refusal | null {
    if (this.isBanned(ip)) return { status: 403, message: 'Access from your network is temporarily blocked.', close: true };
    if (path === '/api/health') return null;
    return this.check(this.ipBucket, ip, ip);
  }

  /**
   * Watch a response for signs of abuse: failed sign-ins (or an invalid API token) and scanning
   * for endpoints that don't exist. Paths compare case-insensitively, like routing.
   */
  watch(res: ServerResponse, ip: string, path: string, invalidToken: () => boolean): void {
    const lower = path.toLowerCase().replace(/(.)\/$/, '$1');
    res.on('finish', () => {
      if (res.statusCode === 401 && (SIGN_IN_PATHS.has(lower) || invalidToken())) this.count(this.authFailures, ip, this.options.ban.authFailures, 'too many failed sign-in attempts');
      else if (res.statusCode === 404 && lower.startsWith('/api/')) this.count(this.notFounds, ip, this.options.ban.notFound, 'probing for API endpoints');
    });
  }

  /** Per-user (or anonymous) API limits; runs once the caller has been identified. */
  apiLimit(ip: string, method: string, member: LimitedMember | null, signInEnabled: boolean): Refusal | null {
    if (signInEnabled && !member) return this.check(this.anonBucket, ip, ip);
    const key = member ? `m:${member.id}` : `ip:${ip}`;
    return this.check(this.userBucket, key, ip) ?? (MUTATING.has(method) ? this.check(this.mutationBucket, key, ip, 'changes') : null);
  }

  /** A sign-in attempt: a strict per-IP limit plus a global cap on concurrent password hashing. */
  signInAttempt(ip: string, res: ServerResponse): Refusal | null {
    const limited = this.check(this.signInBucket, ip, ip, 'sign-in attempts');
    if (limited) return limited;
    if (this.hashing >= this.options.hashConcurrency) return { status: 503, message: 'The server is busy. Try signing in again in a moment.', retryAfter: 2 };
    this.hashing++;
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        this.hashing--;
      }
    };
    res.on('finish', release);
    res.on('close', release);
    return null;
  }

  /** Expensive operations (backups, snapshots, reset) per user or IP. */
  heavy(ip: string, member: LimitedMember | null): Refusal | null {
    return this.check(this.heavyBucket, member ? `m:${member.id}` : `ip:${ip}`, ip, 'backup and snapshot operations');
  }

  /** Reserve a live-update connection: a function that releases it, or why there is none. */
  openStream(ip: string, member: LimitedMember | null): { readonly release: () => void } | Refusal {
    const ipKey = `ip:${ip}`;
    const memberKey = member ? `m:${member.id}` : null;
    const o = this.options;
    if (this.streamsOpen >= o.streamsTotal) return { status: 503, message: 'Too many live connections. Try again later.' };
    if ((this.streams.get(ipKey) ?? 0) >= o.streamsPerIp || (memberKey && (this.streams.get(memberKey) ?? 0) >= o.streamsPerUser)) {
      return tooMany(10_000, 'open tabs');
    }
    const keys = memberKey ? [ipKey, memberKey] : [ipKey];
    this.streamsOpen++;
    for (const k of keys) this.streams.set(k, (this.streams.get(k) ?? 0) + 1);
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.streamsOpen--;
        for (const k of keys) {
          const n = (this.streams.get(k) ?? 1) - 1;
          if (n <= 0) this.streams.delete(k);
          else this.streams.set(k, n);
        }
      },
    };
  }

  /**
   * Cross-site request forgery guard. Browsers attach an Origin header (and Sec-Fetch-Site)
   * to cross-origin requests; changes are only accepted from pages served by this app.
   */
  sameOrigin(method: string, headers: { readonly origin?: string | undefined; readonly host?: string | undefined; readonly fetchSite?: string | undefined }): Refusal | null {
    if (!MUTATING.has(method)) return null;
    if (headers.fetchSite === 'cross-site') return CROSS_SITE;
    const { origin } = headers;
    if (origin === 'null') return CROSS_SITE;
    if (origin) {
      let host: string;
      try {
        host = new URL(origin).host;
      } catch {
        return CROSS_SITE;
      }
      if (host !== headers.host) return CROSS_SITE;
    }
    return null;
  }

  get stats() {
    return { bans: this.bans.size, streamsOpen: this.streamsOpen, hashing: this.hashing, trackedIps: this.ipBucket.size };
  }
}
