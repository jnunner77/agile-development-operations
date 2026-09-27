import type { NextFunction, Request, Response } from 'express';
import { HttpError } from './errors';

// Defensive middleware for running on the open internet: rate limits, temporary bans for
// abusive clients, a cap on concurrent password hashing, cross-site request checks and
// security headers. Everything is in memory, so it resets when the server restarts.

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

function ipv4ToInt(ip: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

/** Build a matcher for exact addresses and IPv4 CIDR ranges ("203.0.113.0/24"). */
export function ipMatcher(entries: string[]): (ip: string) => boolean {
  const exact = new Set<string>();
  const ranges: { base: number; mask: number }[] = [];
  for (const raw of entries.map((e) => e.trim()).filter(Boolean)) {
    const [addr, bits] = raw.split('/');
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

  constructor(
    private readonly limit: Limit,
    private readonly maxKeys: number,
    private readonly now: () => number,
  ) {}

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

  constructor(
    private readonly windowMs: number,
    private readonly maxKeys: number,
    private readonly now: () => number,
  ) {}

  add(key: string): number {
    const now = this.now();
    const list = (this.events.get(key) ?? []).filter((t) => now - t < this.windowMs);
    list.push(now);
    this.events.delete(key);
    if (this.events.size >= this.maxKeys) this.events.delete(this.events.keys().next().value!);
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

function tooMany(retryAfterMs: number, what = 'requests') {
  const secs = Math.max(1, Math.ceil(retryAfterMs / 1000));
  const err = new HttpError(429, `Too many ${what}. Try again in ${secs} second${secs === 1 ? '' : 's'}.`);
  (err as HttpError & { retryAfter?: number }).retryAfter = secs;
  return err;
}

export function retryAfterOf(err: unknown): number | undefined {
  return (err as { retryAfter?: number })?.retryAfter;
}

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

  private check(bucket: TokenBucket, key: string, ip: string, what?: string) {
    if (this.trusted(ip)) return;
    const r = bucket.take(key);
    if (!r.ok) {
      this.count(this.violations, ip, this.options.ban.violations, 'repeatedly exceeded rate limits');
      throw tooMany(r.retryAfterMs, what);
    }
  }

  /**
   * First middleware for every request: rejects banned clients, applies the per-IP limit,
   * and watches responses for signs of abuse (failed sign-ins, scanning for endpoints).
   */
  firewall = (req: Request, res: Response, next: NextFunction) => {
    const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    if (this.isBanned(ip)) {
      res.setHeader('Connection', 'close');
      return res.status(403).json({ error: 'Access from your network is temporarily blocked.' });
    }
    // Routers rewrite req.url while handling a request, so remember the original path now.
    const path = req.path;
    if (path === '/api/health') return next();
    this.check(this.ipBucket, ip, ip);
    res.on('finish', () => {
      if (res.statusCode === 401 && SIGN_IN_PATHS.has(path)) this.count(this.authFailures, ip, this.options.ban.authFailures, 'too many failed sign-in attempts');
      else if (res.statusCode === 404 && path.startsWith('/api/')) this.count(this.notFounds, ip, this.options.ban.notFound, 'probing for API endpoints');
    });
    next();
  };

  /** Per-user (or anonymous) API limits; runs after sign-in has identified the caller. */
  apiLimits = (signInEnabled: () => boolean) => (req: Request, res: Response, next: NextFunction) => {
    if (req.path === '/health') return next();
    const ip = req.ip ?? 'unknown';
    const member = res.locals.authMember as { id: string } | null | undefined;
    if (signInEnabled() && !member) {
      this.check(this.anonBucket, ip, ip);
    } else {
      const key = member ? `m:${member.id}` : `ip:${ip}`;
      this.check(this.userBucket, key, ip);
      if (MUTATING.has(req.method)) this.check(this.mutationBucket, key, ip, 'changes');
    }
    next();
  };

  /** Sign-in attempts: strict per-IP limit plus a global cap on concurrent password hashing. */
  signIn = (req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'POST') return next();
    const ip = req.ip ?? 'unknown';
    this.check(this.signInBucket, ip, ip, 'sign-in attempts');
    if (this.hashing >= this.options.hashConcurrency) {
      res.setHeader('Retry-After', '2');
      throw new HttpError(503, 'The server is busy. Try signing in again in a moment.');
    }
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
    next();
  };

  /** Expensive operations (backups, snapshots, reset) per user or IP. */
  heavy = (req: Request, res: Response, next: NextFunction) => {
    const ip = req.ip ?? 'unknown';
    const member = res.locals.authMember as { id: string } | null | undefined;
    this.check(this.heavyBucket, member ? `m:${member.id}` : `ip:${ip}`, ip, 'backup and snapshot operations');
    next();
  };

  /** Reserve a live-update connection; returns a release function. */
  openStream(req: Request, res: Response): () => void {
    const ip = req.ip ?? 'unknown';
    const member = res.locals.authMember as { id: string } | null | undefined;
    const keys = [`ip:${ip}`, ...(member ? [`m:${member.id}`] : [])];
    const o = this.options;
    if (this.streamsOpen >= o.streamsTotal) throw new HttpError(503, 'Too many live connections. Try again later.');
    if ((this.streams.get(keys[0]) ?? 0) >= o.streamsPerIp || (keys[1] && (this.streams.get(keys[1]) ?? 0) >= o.streamsPerUser)) {
      throw tooMany(10_000, 'open tabs');
    }
    this.streamsOpen++;
    for (const k of keys) this.streams.set(k, (this.streams.get(k) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.streamsOpen--;
      for (const k of keys) {
        const n = (this.streams.get(k) ?? 1) - 1;
        if (n <= 0) this.streams.delete(k);
        else this.streams.set(k, n);
      }
    };
  }

  /**
   * Cross-site request forgery guard. Browsers attach an Origin header (and Sec-Fetch-Site)
   * to cross-origin requests; changes are only accepted from pages served by this app.
   */
  sameOrigin = (req: Request, _res: Response, next: NextFunction) => {
    if (!MUTATING.has(req.method)) return next();
    if (req.get('sec-fetch-site') === 'cross-site') throw new HttpError(403, 'Cross-site requests are not allowed');
    const origin = req.get('origin');
    if (origin && origin !== 'null') {
      let host: string;
      try {
        host = new URL(origin).host;
      } catch {
        throw new HttpError(403, 'Cross-site requests are not allowed');
      }
      if (host !== req.get('host')) throw new HttpError(403, 'Cross-site requests are not allowed');
    } else if (origin === 'null') {
      throw new HttpError(403, 'Cross-site requests are not allowed');
    }
    next();
  };

  get stats() {
    return { bans: this.bans.size, streamsOpen: this.streamsOpen, hashing: this.hashing, trackedIps: this.ipBucket.size };
  }
}

/**
 * Security headers for every response. The content security policy only allows scripts,
 * styles and connections from this app itself; images may also be data: URLs (pasted
 * images) or https (links in descriptions).
 */
export function securityHeaders(_req: Request, res: Response, next: NextFunction) {
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https:",
      "font-src 'self'",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; '),
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  next();
}
