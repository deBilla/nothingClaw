import { describe, it, expect } from 'bun:test';
import { urlAllowed, urlHost } from '../src/lib/url-allowlist.ts';

describe('url-allowlist', () => {
  it('parses host out of a URL and rejects non-http(s)', () => {
    expect(urlHost('https://en.wikipedia.org/wiki/Foo')).toBe('en.wikipedia.org');
    expect(urlHost('http://Example.COM/path?x=1')).toBe('example.com');
    expect(urlHost('file:///etc/passwd')).toBeNull();
    expect(urlHost('javascript:alert(1)')).toBeNull();
    expect(urlHost('not-a-url')).toBeNull();
  });

  it('rejects loopback hostnames so they can never sit on an allow-list as a smuggling channel', () => {
    expect(urlHost('http://127.0.0.1/')).toBeNull();
    expect(urlHost('http://localhost/')).toBeNull();
    expect(urlHost('http://[::1]/')).toBeNull();
  });

  it('bare entry matches the exact host and any subdomain', () => {
    const list = ['wikipedia.org'];
    expect(urlAllowed('https://wikipedia.org/', list)).toBe(true);
    expect(urlAllowed('https://en.wikipedia.org/x', list)).toBe(true);
    expect(urlAllowed('https://commons.m.wikipedia.org/x', list)).toBe(true);
    // Not a parent / not a sibling
    expect(urlAllowed('https://org/', list)).toBe(false);
    expect(urlAllowed('https://notwikipedia.org/', list)).toBe(false);
  });

  it('wildcard entry "*.example.com" covers subdomains and the apex', () => {
    const list = ['*.gov'];
    expect(urlAllowed('https://nasa.gov/', list)).toBe(true);
    expect(urlAllowed('https://data.nasa.gov/', list)).toBe(true);
    // The bare ".gov" host (which DNS allows in principle) also matches
    expect(urlAllowed('https://gov/', list)).toBe(true);
  });

  it('empty allow-list denies everything (safe default)', () => {
    expect(urlAllowed('https://wikipedia.org/', [])).toBe(false);
    expect(urlAllowed('https://anything.example/', [])).toBe(false);
  });

  it('does not allow look-alike domains via suffix tricks', () => {
    // "evilwikipedia.org" must not match "wikipedia.org"
    expect(urlAllowed('https://evilwikipedia.org/', ['wikipedia.org'])).toBe(false);
    // " ?host=" smuggling attempts: hostname is the parsed host, not the query
    expect(urlAllowed('https://attacker.com/?host=wikipedia.org', ['wikipedia.org'])).toBe(false);
  });

  it('ignores whitespace and case in allow-list entries', () => {
    expect(urlAllowed('https://Example.com/', ['  EXAMPLE.com  '])).toBe(true);
  });

  it('rejects IDN homograph hosts even when their allow-list entry looks the same', () => {
    // Cyrillic а (U+0430) — visually identical to Latin a, but a different
    // codepoint. WHATWG URL parses Unicode hostnames into Punycode (xn--…).
    // Both shapes must be denied so an attacker can't pivot through a typo'd
    // allow-list entry.
    const list = ['wikipedia.org'];
    expect(urlAllowed('https://wikipediа.org/', list)).toBe(false);
    expect(urlAllowed('https://xn--wikipedi-86g.org/', list)).toBe(false);
    expect(urlHost('https://wikipediа.org/')).toBeNull();
    expect(urlHost('https://xn--wikipedi-86g.org/')).toBeNull();
  });

  it('rejects non-ASCII allow-list entries (dead config, would silently never match)', () => {
    // Pure ASCII host but Unicode in the allow-list entry — the operator
    // probably typed the wrong codepoint. Must not match anything quietly.
    expect(urlAllowed('https://wikipedia.org/', ['wikipediа.org'])).toBe(false);
  });
});
