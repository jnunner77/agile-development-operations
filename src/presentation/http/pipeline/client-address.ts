import type { IncomingMessage } from 'node:http';
import net from 'node:net';

// Who a request really comes from, and whether it arrived over HTTPS, when the server runs behind
// reverse proxies. Same rules as Express's "trust proxy" setting: walk X-Forwarded-For back from
// the connection, past every proxy that is trusted, to the first address that isn't.

/** Unset or false: no proxy. true: trust every hop. A number: trust that many hops. A string: trusted addresses. */
export type TrustProxy = boolean | number | string | undefined;

/** Whether the address at hop `i` (0 is the connection itself) is a proxy to trust. */
type Trust = (address: string, hop: number) => boolean;

/** Named ranges, as Express accepts them. */
const NAMED: Readonly<Record<string, readonly string[]>> = {
  loopback: ['127.0.0.1/8', '::1/128'],
  linklocal: ['169.254.0.0/16', 'fe80::/10'],
  uniquelocal: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', 'fc00::/7'],
};

/** An address as 16 bytes (IPv4 as IPv4-mapped IPv6), or null if it isn't one. */
function bytesOf(address: string): Uint8Array | null {
  const plain = address.replace(/^\[|\]$/g, '');
  if (net.isIPv4(plain)) return bytesOf(`::ffff:${plain}`);
  if (!net.isIPv6(plain)) return null;
  const [head = '', tail] = plain.split('::');
  const groups = (part: string): number[] => {
    if (!part) return [];
    const out: number[] = [];
    for (const piece of part.split(':')) {
      if (net.isIPv4(piece)) {
        const [a = 0, b = 0, c = 0, d = 0] = piece.split('.').map(Number);
        out.push((a << 8) | b, (c << 8) | d);
      } else out.push(parseInt(piece, 16));
    }
    return out;
  };
  const front = groups(head);
  const back = tail === undefined ? [] : groups(tail);
  const words = tail === undefined ? front : [...front, ...Array<number>(8 - front.length - back.length).fill(0), ...back];
  if (words.length !== 8) return null;
  const bytes = new Uint8Array(16);
  words.forEach((w, i) => {
    bytes[i * 2] = w >> 8;
    bytes[i * 2 + 1] = w & 0xff;
  });
  return bytes;
}

/** The prefix length a dotted IPv4 netmask stands for ("255.255.0.0" is 16), or null if it isn't one. */
function netmaskBits(mask: string): number | null {
  if (!net.isIPv4(mask)) return null;
  const bits = mask
    .split('.')
    .map((part) => Number(part).toString(2).padStart(8, '0'))
    .join('');
  const ones = bits.indexOf('0') === -1 ? 32 : bits.indexOf('0');
  return /^1*0*$/.test(bits) && ones >= 1 ? ones : null;
}

/** The prefix length a range gives, or null if it is malformed: "8" (1–32 or 1–128), or a netmask. */
function prefixBits(bits: string, v4: boolean): number | null {
  if (/^\d+$/.test(bits)) {
    const n = Number(bits);
    return n >= 1 && n <= (v4 ? 32 : 128) ? n : null;
  }
  return v4 ? netmaskBits(bits) : null;
}

/** A matcher for one address or range: "10.0.0.1", "10.0.0.0/8", "10.0.0.0/255.0.0.0", "fd00::/8". */
function rangeMatcher(entry: string): ((address: string) => boolean) | null {
  const [addr = '', bits, extra] = entry.split('/');
  const base = bytesOf(addr);
  if (!base || extra !== undefined) return null;
  const v4 = net.isIPv4(addr);
  const bitsGiven = bits === undefined ? (v4 ? 32 : 128) : prefixBits(bits, v4);
  if (bitsGiven === null) return null;
  const prefix = bitsGiven + (v4 ? 96 : 0);
  return (address) => {
    const bytes = bytesOf(address);
    if (!bytes) return false;
    for (let bit = 0; bit < prefix; bit++) {
      const i = bit >> 3;
      const mask = 0x80 >> (bit & 7);
      if (((bytes[i] ?? 0) & mask) !== ((base[i] ?? 0) & mask)) return false;
    }
    return true;
  };
}

export function trustFunction(setting: TrustProxy): Trust {
  if (setting === undefined || setting === false) return () => false;
  if (setting === true) return () => true;
  if (typeof setting === 'number') return (_address, hop) => hop < setting;
  const matchers = setting
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .flatMap((s) => NAMED[s] ?? [s])
    .map((s) => {
      const matcher = rangeMatcher(s);
      if (!matcher) throw new Error(`TRUST_PROXY: "${s}" is not an address, a range or a known name`);
      return matcher;
    });
  return (address) => matchers.some((m) => m(address));
}

function header(req: IncomingMessage, name: string): string {
  const value = req.headers[name];
  return Array.isArray(value) ? value.join(',') : (value ?? '');
}

export interface ClientAddress {
  readonly ip: string;
  /** The request reached the server (or the first trusted proxy) over HTTPS. */
  readonly secure: boolean;
}

export function clientAddress(req: IncomingMessage, trust: Trust): ClientAddress {
  const socketAddress = req.socket.remoteAddress ?? 'unknown';
  // From the connection outwards: the socket, then X-Forwarded-For right to left.
  const forwarded = header(req, 'x-forwarded-for')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .reverse();
  const hops = [socketAddress, ...forwarded];
  let ip = hops[hops.length - 1] ?? socketAddress;
  for (let i = 0; i < hops.length - 1; i++) {
    const hop = hops[i] ?? socketAddress;
    if (!trust(hop, i)) {
      ip = hop;
      break;
    }
  }
  const encrypted = 'encrypted' in req.socket && req.socket.encrypted === true;
  let secure = encrypted;
  if (!encrypted && trust(socketAddress, 0)) {
    const proto = header(req, 'x-forwarded-proto').split(',')[0]?.trim().toLowerCase();
    secure = proto === 'https';
  }
  return { ip, secure };
}
