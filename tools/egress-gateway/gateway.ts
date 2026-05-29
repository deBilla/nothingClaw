// Local egress gateway — an SSRF-protected forward proxy.
//
// The "contain, don't censor" boundary: the agent (and the SDK subprocess, the
// MCP child, WebFetch) are pointed here via HTTPS_PROXY/HTTP_PROXY. Every
// outbound connection's destination is resolved and SSRF-checked before a byte
// flows. The agent can fetch any *public* host; it can never be steered into
// loopback, the private network, or the cloud-metadata endpoint.
//
// On Linux the bot runs in a netns whose only route is this process, so this is
// the sole egress path (airtight). On macOS it's reached via proxy env vars
// plus an optional pf anchor (best-effort) — see tools/sandbox/.
//
// HTTPS is tunneled via CONNECT (no TLS interception — we gate the destination,
// then blind-pipe the encrypted bytes). Plain HTTP is forwarded in absolute
// form rewritten to origin form. DNS is resolved once and we connect to that
// pinned IP, so a rebinding race can't swap a vetted public IP for an internal
// one between check and connect.

import { lookup } from 'node:dns/promises';
import type { Socket } from 'bun';
import { anyBlocked } from './ssrf.ts';
import { audit } from '../../src/lib/audit-log.ts';

const PORT = Number(process.env.EGRESS_GATEWAY_PORT ?? 8775);
const HOST = process.env.EGRESS_GATEWAY_HOST ?? '127.0.0.1';
// Cap on the plaintext request header we buffer before we've parsed it. A
// client that never sends a complete header line just gets dropped.
const MAX_HEADER_BYTES = 64 * 1024;

interface ConnState {
  stage: 'reading-request' | 'connecting' | 'piping' | 'closed';
  header: Uint8Array[]; // accumulated bytes until the request is parsed
  headerLen: number;
  upstream?: Socket<UpstreamData>;
  // Bytes that arrived from the client before upstream was ready.
  pending: Uint8Array[];
}

interface UpstreamData {
  client: Socket<ConnState>;
}

const dec = new TextDecoder();
const enc = new TextEncoder();

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
  return out;
}

function deny(client: Socket<ConnState>, code: number, msg: string, host: string, reason: string): void {
  audit({ tool: 'egress-gateway', decision: 'deny', layer: 'egress-gateway', subject: host, reason });
  try {
    client.write(enc.encode(`HTTP/1.1 ${code} ${msg}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`));
    client.end();
  } catch {
    /* client already gone */
  }
  client.data.stage = 'closed';
}

// Resolve a hostname to all of its IPs (or treat a literal IP as itself).
async function resolveAll(host: string): Promise<string[]> {
  try {
    const recs = await lookup(host, { all: true });
    return recs.map((r) => r.address);
  } catch {
    return [];
  }
}

async function startTunnel(
  client: Socket<ConnState>,
  host: string,
  port: number,
  isConnect: boolean,
  rewrittenRequest: Uint8Array | null,
): Promise<void> {
  const ips = await resolveAll(host);
  const verdict = anyBlocked(ips);
  if (verdict.blocked) {
    deny(client, 403, 'Forbidden', `${host}:${port}`, verdict.reason ?? 'ssrf-blocked');
    return;
  }
  // Pin to the first vetted IP (all were checked; rebinding can't help).
  const pinned = ips[0]!;
  client.data.stage = 'connecting';

  try {
    const upstream = await Bun.connect<UpstreamData>({
      hostname: pinned,
      port,
      socket: {
        open(up) {
          if (isConnect) {
            client.write(enc.encode('HTTP/1.1 200 Connection Established\r\n\r\n'));
          } else if (rewrittenRequest) {
            up.write(rewrittenRequest);
          }
          // Flush anything the client sent while we were connecting.
          for (const chunk of client.data.pending) up.write(chunk);
          client.data.pending = [];
          client.data.stage = 'piping';
          audit({
            tool: 'egress-gateway',
            decision: 'allow',
            layer: 'egress-gateway',
            subject: `${isConnect ? 'CONNECT' : 'HTTP'} ${host}:${port} → ${pinned}`,
          });
        },
        data(up, chunk) {
          up.data.client.write(chunk);
        },
        close(up) {
          try {
            up.data.client.end();
          } catch {
            /* gone */
          }
        },
        error(up) {
          try {
            up.data.client.end();
          } catch {
            /* gone */
          }
        },
      },
      data: { client },
    });
    client.data.upstream = upstream;
  } catch {
    deny(client, 502, 'Bad Gateway', `${host}:${port}`, 'upstream-connect-failed');
  }
}

// Parse the proxy request once we have the full header block. Returns false if
// we don't yet have enough bytes (caller keeps buffering).
function tryHandleRequest(client: Socket<ConnState>): boolean {
  const buf = concat(client.data.header);
  const text = dec.decode(buf);
  const headerEnd = text.indexOf('\r\n\r\n');
  const firstLineEnd = text.indexOf('\r\n');
  if (firstLineEnd === -1) return false;

  const requestLine = text.slice(0, firstLineEnd);
  const [method, target] = requestLine.split(' ');
  if (!method || !target) {
    deny(client, 400, 'Bad Request', target ?? '?', 'malformed-request-line');
    return true;
  }

  if (method.toUpperCase() === 'CONNECT') {
    // CONNECT host:port — we only need the request line.
    const [host, portStr] = target.split(':');
    const port = Number(portStr ?? 443);
    if (!host || !Number.isFinite(port)) {
      deny(client, 400, 'Bad Request', target, 'malformed-connect-target');
      return true;
    }
    void startTunnel(client, host, port, true, null);
    return true;
  }

  // Absolute-form HTTP (GET http://host/path …). Need full headers first.
  if (headerEnd === -1) return false;
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    deny(client, 400, 'Bad Request', target, 'non-absolute-uri');
    return true;
  }
  if (url.protocol !== 'http:') {
    deny(client, 400, 'Bad Request', target, 'unsupported-scheme');
    return true;
  }
  const host = url.hostname;
  const port = Number(url.port || 80);
  // Rewrite the request line to origin form for the upstream.
  const originPath = url.pathname + url.search;
  const rest = text.slice(firstLineEnd); // includes the leading \r\n and headers + body
  const rewritten = enc.encode(`${method} ${originPath} HTTP/1.1${rest}`);
  void startTunnel(client, host, port, false, rewritten);
  return true;
}

Bun.listen<ConnState>({
  hostname: HOST,
  port: PORT,
  socket: {
    open(socket) {
      socket.data = { stage: 'reading-request', header: [], headerLen: 0, pending: [] };
    },
    data(socket, chunk) {
      const st = socket.data;
      if (st.stage === 'piping' && st.upstream) {
        st.upstream.write(chunk);
        return;
      }
      if (st.stage === 'connecting') {
        // Upstream not ready yet — buffer.
        st.pending.push(chunk);
        return;
      }
      if (st.stage === 'reading-request') {
        st.header.push(chunk);
        st.headerLen += chunk.byteLength;
        if (st.headerLen > MAX_HEADER_BYTES) {
          deny(socket, 431, 'Request Header Fields Too Large', '?', 'oversized-header');
          return;
        }
        tryHandleRequest(socket);
      }
    },
    close(socket) {
      socket.data.stage = 'closed';
      try {
        socket.data.upstream?.end();
      } catch {
        /* gone */
      }
    },
    error(socket) {
      try {
        socket.data.upstream?.end();
      } catch {
        /* gone */
      }
    },
  },
});

console.log(`egress-gateway listening on ${HOST}:${PORT} (SSRF-protected forward proxy)`);
