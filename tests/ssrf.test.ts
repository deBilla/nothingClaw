import { describe, it, expect } from 'bun:test';
import { classifyIp, anyBlocked } from '../tools/egress-gateway/ssrf.ts';

describe('ssrf classifyIp — IPv4', () => {
  it('allows ordinary public addresses', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '140.82.112.3']) {
      expect(classifyIp(ip).blocked).toBe(false);
    }
  });

  it('blocks loopback', () => {
    expect(classifyIp('127.0.0.1')).toMatchObject({ blocked: true, reason: 'loopback' });
    expect(classifyIp('127.1.2.3')).toMatchObject({ blocked: true, reason: 'loopback' });
  });

  it('blocks the cloud metadata address (the classic SSRF target)', () => {
    expect(classifyIp('169.254.169.254')).toMatchObject({ blocked: true, reason: 'link-local' });
  });

  it('blocks RFC1918 private ranges', () => {
    expect(classifyIp('10.0.0.1').blocked).toBe(true);
    expect(classifyIp('172.16.5.4').blocked).toBe(true);
    expect(classifyIp('172.31.255.255').blocked).toBe(true);
    expect(classifyIp('192.168.1.1').blocked).toBe(true);
    // Just outside 172.16/12 is public.
    expect(classifyIp('172.32.0.1').blocked).toBe(false);
    expect(classifyIp('172.15.0.1').blocked).toBe(false);
  });

  it('blocks CGNAT, this-network, broadcast, multicast, reserved', () => {
    expect(classifyIp('100.64.0.1').blocked).toBe(true);
    expect(classifyIp('0.0.0.0').blocked).toBe(true);
    expect(classifyIp('255.255.255.255')).toMatchObject({ blocked: true, reason: 'broadcast' });
    expect(classifyIp('224.0.0.1')).toMatchObject({ blocked: true, reason: 'multicast' });
    expect(classifyIp('240.0.0.1')).toMatchObject({ blocked: true, reason: 'reserved' });
  });

  it('fails closed on garbage', () => {
    expect(classifyIp('999.1.1.1').blocked).toBe(true);
    expect(classifyIp('not-an-ip').blocked).toBe(true);
    expect(classifyIp('').blocked).toBe(true);
  });
});

describe('ssrf classifyIp — IPv6', () => {
  it('allows public v6', () => {
    expect(classifyIp('2606:4700:4700::1111').blocked).toBe(false); // cloudflare
    expect(classifyIp('2001:4860:4860::8888').blocked).toBe(false); // google
  });

  it('blocks loopback / unspecified', () => {
    expect(classifyIp('::1')).toMatchObject({ blocked: true, reason: 'loopback' });
    expect(classifyIp('::')).toMatchObject({ blocked: true, reason: 'unspecified' });
  });

  it('blocks unique-local and link-local', () => {
    expect(classifyIp('fc00::1')).toMatchObject({ blocked: true, reason: 'unique-local' });
    expect(classifyIp('fd12:3456::1')).toMatchObject({ blocked: true, reason: 'unique-local' });
    expect(classifyIp('fe80::1')).toMatchObject({ blocked: true, reason: 'link-local' });
  });

  it('blocks multicast', () => {
    expect(classifyIp('ff02::1')).toMatchObject({ blocked: true, reason: 'multicast' });
  });

  it('unwraps IPv4-mapped addresses and classifies the embedded v4', () => {
    // ::ffff:169.254.169.254 must still be caught as metadata.
    expect(classifyIp('::ffff:169.254.169.254').blocked).toBe(true);
    expect(classifyIp('::ffff:127.0.0.1').blocked).toBe(true);
    expect(classifyIp('::ffff:8.8.8.8').blocked).toBe(false);
  });
});

describe('ssrf anyBlocked', () => {
  it('blocks if ANY resolved IP is internal (DNS-rebinding defence)', () => {
    expect(anyBlocked(['93.184.216.34', '10.0.0.5']).blocked).toBe(true);
    expect(anyBlocked(['93.184.216.34', '1.1.1.1']).blocked).toBe(false);
  });

  it('fails closed on an empty resolution', () => {
    expect(anyBlocked([]).blocked).toBe(true);
  });
});
