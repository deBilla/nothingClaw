// SSRF classification — is an IP address one the agent must never reach?
//
// The egress gateway resolves each target hostname to its IP(s) and refuses to
// connect if ANY resolved address is in a blocked range. This is the core of
// the "contain, don't censor" model: the agent can ask to fetch any *host*,
// but it can never be steered into the host's internal network, cloud metadata
// endpoint, or loopback services.
//
// Pure, socket-free, and dependency-free so it unit-tests trivially. `net.isIP`
// is the only Node primitive used (to pick v4 vs v6 parsing).

import { isIP } from 'node:net';

export interface SsrfVerdict {
  blocked: boolean;
  /** Human-readable category when blocked (loopback, private, metadata, …). */
  reason?: string;
}

const ALLOWED: SsrfVerdict = { blocked: false };

// --- IPv4 -----------------------------------------------------------------

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = (n << 8) | v;
  }
  // >>> 0 to read as unsigned.
  return n >>> 0;
}

function inCidr(ipInt: number, baseIp: string, maskBits: number): boolean {
  const base = ipv4ToInt(baseIp);
  if (base === null) return false;
  if (maskBits === 0) return true;
  const mask = (0xffffffff << (32 - maskBits)) >>> 0;
  return (ipInt & mask) === (base & mask);
}

// (cidr base, prefix bits, reason). Order doesn't matter — first match wins.
const V4_BLOCKS: [string, number, string][] = [
  ['0.0.0.0', 8, 'this-network'],
  ['10.0.0.0', 8, 'private'],
  ['100.64.0.0', 10, 'cgnat'],
  ['127.0.0.0', 8, 'loopback'],
  ['169.254.0.0', 16, 'link-local'], // includes 169.254.169.254 cloud metadata
  ['172.16.0.0', 12, 'private'],
  ['192.0.0.0', 24, 'ietf-protocol'],
  ['192.0.2.0', 24, 'documentation'],
  ['192.168.0.0', 16, 'private'],
  ['198.18.0.0', 15, 'benchmark'],
  ['198.51.100.0', 24, 'documentation'],
  ['203.0.113.0', 24, 'documentation'],
  ['224.0.0.0', 4, 'multicast'],
  ['240.0.0.0', 4, 'reserved'],
];

function classifyV4(ip: string): SsrfVerdict {
  const n = ipv4ToInt(ip);
  if (n === null) return { blocked: true, reason: 'unparseable-ipv4' };
  if (n === 0xffffffff) return { blocked: true, reason: 'broadcast' };
  for (const [base, bits, reason] of V4_BLOCKS) {
    if (inCidr(n, base, bits)) return { blocked: true, reason };
  }
  return ALLOWED;
}

// --- IPv6 -----------------------------------------------------------------

// Expand an IPv6 address to its 8 16-bit groups. Handles "::" compression and
// embedded IPv4 (e.g. "::ffff:1.2.3.4"). Returns null if malformed.
function ipv6Groups(ip: string): number[] | null {
  let s = ip;
  // Strip zone id (fe80::1%en0).
  const pct = s.indexOf('%');
  if (pct !== -1) s = s.slice(0, pct);

  // Embedded IPv4 tail → convert to two hextets.
  let v4Tail: number[] | null = null;
  const lastColon = s.lastIndexOf(':');
  const tail = lastColon === -1 ? s : s.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = ipv4ToInt(tail);
    if (v4 === null) return null;
    v4Tail = [(v4 >>> 16) & 0xffff, v4 & 0xffff];
    s = s.slice(0, lastColon + 1) + '0:0';
  }

  const dbl = s.split('::');
  if (dbl.length > 2) return null;

  const parse = (chunk: string): number[] | null => {
    if (chunk === '') return [];
    const out: number[] = [];
    for (const h of chunk.split(':')) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(h)) return null;
      out.push(parseInt(h, 16));
    }
    return out;
  };

  let groups: number[];
  if (dbl.length === 2) {
    const head = parse(dbl[0]!);
    const tailG = parse(dbl[1]!);
    if (head === null || tailG === null) return null;
    const fill = 8 - head.length - tailG.length;
    if (fill < 0) return null;
    groups = [...head, ...Array(fill).fill(0), ...tailG];
  } else {
    const all = parse(s);
    if (all === null) return null;
    groups = all;
  }

  // If we substituted a v4 tail's "0:0", overwrite the last two groups.
  if (v4Tail) {
    groups[6] = v4Tail[0]!;
    groups[7] = v4Tail[1]!;
  }
  return groups.length === 8 ? groups : null;
}

function classifyV6(ip: string): SsrfVerdict {
  const g = ipv6Groups(ip);
  if (g === null) return { blocked: true, reason: 'unparseable-ipv6' };

  // IPv4-mapped (::ffff:0:0/96) and IPv4-compatible — classify the embedded v4.
  const allZeroHead = g.slice(0, 5).every((x) => x === 0);
  if (allZeroHead && (g[5] === 0xffff || g[5] === 0)) {
    const v4 = `${(g[6]! >> 8) & 0xff}.${g[6]! & 0xff}.${(g[7]! >> 8) & 0xff}.${g[7]! & 0xff}`;
    // ::1 (loopback) and :: (unspecified) fall out of this as 0.0.0.x / 0.0.0.1.
    if (g[5] === 0 && g[6] === 0 && (g[7] === 0 || g[7] === 1)) {
      return { blocked: true, reason: g[7] === 1 ? 'loopback' : 'unspecified' };
    }
    return classifyV4(v4);
  }

  const first = g[0]!;
  if ((first & 0xfe00) === 0xfc00) return { blocked: true, reason: 'unique-local' }; // fc00::/7
  if ((first & 0xffc0) === 0xfe80) return { blocked: true, reason: 'link-local' }; // fe80::/10
  if ((first & 0xff00) === 0xff00) return { blocked: true, reason: 'multicast' }; // ff00::/8
  if (g.every((x) => x === 0)) return { blocked: true, reason: 'unspecified' };
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return { blocked: true, reason: 'loopback' };
  return ALLOWED;
}

/** Classify a literal IP address string. Unknown/garbage → blocked (fail closed). */
export function classifyIp(ip: string): SsrfVerdict {
  const fam = isIP(ip);
  if (fam === 4) return classifyV4(ip);
  if (fam === 6) return classifyV6(ip);
  return { blocked: true, reason: 'not-an-ip' };
}

/**
 * Given the IPs a hostname resolved to, return blocked if ANY is in a blocked
 * range (an attacker who controls DNS can return one public + one internal IP;
 * we must refuse the whole connection). Empty list → blocked (fail closed).
 */
export function anyBlocked(ips: string[]): SsrfVerdict {
  if (ips.length === 0) return { blocked: true, reason: 'no-resolved-ips' };
  for (const ip of ips) {
    const v = classifyIp(ip);
    if (v.blocked) return v;
  }
  return ALLOWED;
}
