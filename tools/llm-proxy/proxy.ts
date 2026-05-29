// Local LLM credential-isolation proxy.
//
// The agent process today holds ANTHROPIC_API_KEY and CLAUDE_CODE_OAUTH_TOKEN
// in its env. A successful prompt injection that obtains shell or arbitrary
// file read can exfiltrate either. This proxy lets you keep the real creds
// out of the agent's environment:
//
//   ┌────────────────────┐    Authorization: Bearer <session-token>
//   │ agent (sandboxed)  │ ─────────────────────────────────────────► 127.0.0.1:8765
//   │ ANTHROPIC_BASE_URL │                                              │
//   │ = http://127:8765  │                                              │ swaps in real
//   │ ANTHROPIC_API_KEY  │                                              │ ANTHROPIC_API_KEY
//   │ = <session-token>  │                                              ▼
//   └────────────────────┘                                       api.anthropic.com
//
// Properties:
//   - The real key is set in the proxy's env only, never in the agent's.
//   - The proxy verifies a per-deployment session token before forwarding —
//     a leaked session token is rotatable without touching Anthropic.
//   - Only the Anthropic host + Messages-shaped paths are forwarded; anything
//     else gets a 404 (no general HTTP proxy capability for the agent).
//   - The upstream response is streamed back unchanged, so SSE token-streaming
//     in the Anthropic Messages API still works.
//   - Every request is recorded into the same audit log the in-process gates
//     write to (`logs/audit.log` via `src/lib/audit-log.ts`), so wire-level
//     events line up with tool decisions in one place.
//
// Out of scope for this stub:
//   - PII redaction (placeholder hook is wired but no-op)
//   - Per-thread budgeting (cost-tracker.ts already does this in-agent; this
//     proxy can take it over so it survives agent compromise)
//   - Gemini support (Gemini CLI uses OAuth-via-browser, not a bearer; needs
//     a different shape)

import { audit } from '../../src/lib/audit-log.ts';

const PORT = Number(process.env.LLM_PROXY_PORT ?? 8765);
const HOST = process.env.LLM_PROXY_HOST ?? '127.0.0.1';
const UPSTREAM = process.env.LLM_PROXY_UPSTREAM ?? 'https://api.anthropic.com';

const REAL_API_KEY = process.env.ANTHROPIC_API_KEY;
const REAL_OAUTH = process.env.CLAUDE_CODE_OAUTH_TOKEN;
const SESSION_TOKEN = process.env.LLM_PROXY_SESSION_TOKEN;

if (!REAL_API_KEY && !REAL_OAUTH) {
  console.error('llm-proxy: neither ANTHROPIC_API_KEY nor CLAUDE_CODE_OAUTH_TOKEN set — nothing to proxy');
  process.exit(1);
}
if (!SESSION_TOKEN) {
  console.error('llm-proxy: LLM_PROXY_SESSION_TOKEN is required (rotate this independently of the real key)');
  process.exit(1);
}

// Paths we forward. Anthropic Messages API + the SDK's auxiliary endpoints.
// Compared against the parsed `url.pathname`, which the WHATWG URL parser has
// already collapsed (`..` segments cannot survive parsing into pathname).
const ALLOWED_PREFIXES = ['/v1/messages', '/v1/models', '/v1/complete'];

function isAllowedPath(p: string): boolean {
  // Defense-in-depth: a `..` in the literal pathname means the parser saw it
  // as a NAMED segment (e.g. `/v1/messages%2F..%2Fadmin`) — refuse explicitly.
  if (p.includes('..')) return false;
  return ALLOWED_PREFIXES.some((prefix) => p === prefix || p.startsWith(`${prefix}/`));
}

// Hook point for PII redaction. Stub returns body unchanged. Plug a regex
// sweep here (emails, phone numbers, refresh-token shapes) before requests
// reach Anthropic if your threat model includes their server-side logs.
function redact(body: string): string {
  return body;
}

interface AuditLine {
  method: string;
  path: string;
  status: number;
  ms: number;
  bytesIn: number;
  bytesOut: number;
  preview?: string;
  reason?: string;
}

function record(line: AuditLine): void {
  // Funnel into the in-process audit log so the operator has one file to
  // grep. `decision: 'allow'` for forwarded, `'deny'` for rejected (auth
  // fail / path not allowed), `'blocked'` reserved for budget-gate later.
  const decision: 'allow' | 'deny' | 'blocked' = line.status >= 400 && line.status < 500 ? 'deny' : 'allow';
  audit({
    tool: 'llm-proxy',
    decision,
    layer: 'url-allowlist',
    subject: `${line.method} ${line.path} → ${line.status} (${line.ms}ms, ${line.bytesIn}B→${line.bytesOut}B)`,
    reason: line.reason,
  });
  // Also tee to stdout (launchd/systemd capture) as one structured JSON line
  // so an operator watching `tail -f` sees activity in real time.
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...line }));
}

function previewBody(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { messages?: { content?: unknown }[] };
    const last = parsed.messages?.[parsed.messages.length - 1];
    const content = typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content ?? '');
    return content.slice(0, 200);
  } catch {
    return body.slice(0, 200);
  }
}

Bun.serve({
  port: PORT,
  hostname: HOST,
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const startedAt = performance.now();
    const baseLog = { method: req.method, path: url.pathname };

    if (!isAllowedPath(url.pathname)) {
      record({ ...baseLog, status: 404, ms: 0, bytesIn: 0, bytesOut: 0, reason: 'path not allowed' });
      return new Response('not found', { status: 404 });
    }

    const presented = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? req.headers.get('x-api-key');
    if (presented !== SESSION_TOKEN) {
      record({ ...baseLog, status: 401, ms: 0, bytesIn: 0, bytesOut: 0, reason: 'bad session token' });
      return new Response('unauthorized', { status: 401 });
    }

    const bodyText = req.method === 'GET' || req.method === 'HEAD' ? '' : redact(await req.text());
    const upstreamHeaders = new Headers(req.headers);
    upstreamHeaders.delete('host');
    upstreamHeaders.delete('authorization');
    upstreamHeaders.delete('x-api-key');
    if (REAL_OAUTH) {
      upstreamHeaders.set('authorization', `Bearer ${REAL_OAUTH}`);
    } else if (REAL_API_KEY) {
      upstreamHeaders.set('x-api-key', REAL_API_KEY);
      upstreamHeaders.set('anthropic-version', upstreamHeaders.get('anthropic-version') ?? '2023-06-01');
    }

    const upstreamUrl = `${UPSTREAM}${url.pathname}${url.search}`;
    const resp = await fetch(upstreamUrl, {
      method: req.method,
      headers: upstreamHeaders,
      body: bodyText.length > 0 ? bodyText : undefined,
    });

    // Stream the upstream body through unchanged. Critical for SSE responses
    // from /v1/messages — buffering would defeat token-by-token streaming.
    // We tee bytes through a TransformStream to count them for the audit
    // line without materialising the whole response in memory.
    let bytesOut = 0;
    const teed = resp.body?.pipeThrough(
      new TransformStream({
        transform(chunk: Uint8Array, controller) {
          bytesOut += chunk.byteLength;
          controller.enqueue(chunk);
        },
        flush() {
          record({
            ...baseLog,
            status: resp.status,
            ms: Math.round(performance.now() - startedAt),
            bytesIn: bodyText.length,
            bytesOut,
            preview: bodyText.length > 0 ? previewBody(bodyText) : undefined,
          });
        },
      }),
    );
    // No body (e.g. 204) — record immediately and return empty.
    if (!teed) {
      record({
        ...baseLog,
        status: resp.status,
        ms: Math.round(performance.now() - startedAt),
        bytesIn: bodyText.length,
        bytesOut: 0,
        preview: bodyText.length > 0 ? previewBody(bodyText) : undefined,
      });
      return new Response(null, { status: resp.status, headers: resp.headers });
    }
    return new Response(teed, { status: resp.status, headers: resp.headers });
  },
});

console.log(`llm-proxy listening on http://${HOST}:${PORT} → ${UPSTREAM}`);
