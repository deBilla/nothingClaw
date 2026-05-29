// Local LLM credential-isolation proxy. STUB.
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
//   - Every request is logged with model, in/out tokens, latency, and the
//     first 200 chars of the prompt — providing one place to enforce per-day
//     budgets, redact PII, or block unusual patterns.
//
// Out of scope for this stub:
//   - PII redaction (placeholder hook is wired)
//   - Per-thread budgeting (cost-tracker.ts already does this in-agent; this
//     proxy can take it over so it survives agent compromise)
//   - Gemini support (Gemini CLI uses OAuth-via-browser, not a bearer; needs
//     a different shape — file an issue)

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
const ALLOWED_PREFIXES = ['/v1/messages', '/v1/models', '/v1/complete'];

function isAllowedPath(p: string): boolean {
  return ALLOWED_PREFIXES.some((prefix) => p === prefix || p.startsWith(`${prefix}/`) || p.startsWith(`${prefix}?`));
}

// Hook point for PII redaction. Stub returns body unchanged.
function redact(body: string): string {
  return body;
}

interface LogLine {
  ts: string;
  method: string;
  path: string;
  status: number;
  ms: number;
  bytesIn: number;
  bytesOut: number;
  preview?: string;
  reason?: string;
}

function logLine(line: LogLine): void {
  // Stdout is captured by launchd / systemd into logs/. Keep it as JSONL so a
  // future audit-log sink can ingest it uniformly with logs/audit.log.
  console.log(JSON.stringify(line));
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
    const baseLog = { ts: new Date().toISOString(), method: req.method, path: url.pathname };

    if (!isAllowedPath(url.pathname)) {
      logLine({ ...baseLog, status: 404, ms: 0, bytesIn: 0, bytesOut: 0, reason: 'path not allowed' });
      return new Response('not found', { status: 404 });
    }

    const presented = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? req.headers.get('x-api-key');
    if (presented !== SESSION_TOKEN) {
      logLine({ ...baseLog, status: 401, ms: 0, bytesIn: 0, bytesOut: 0, reason: 'bad session token' });
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

    // Stream the body through unchanged. We read the size for the audit line
    // without buffering by piping through a tee — but for the stub, buffer.
    const outBody = await resp.arrayBuffer();
    logLine({
      ...baseLog,
      status: resp.status,
      ms: Math.round(performance.now() - startedAt),
      bytesIn: bodyText.length,
      bytesOut: outBody.byteLength,
      preview: bodyText.length > 0 ? previewBody(bodyText) : undefined,
    });
    return new Response(outBody, { status: resp.status, headers: resp.headers });
  },
});

console.log(`llm-proxy listening on http://${HOST}:${PORT} → ${UPSTREAM}`);
