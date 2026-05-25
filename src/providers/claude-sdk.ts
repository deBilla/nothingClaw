// Claude path via @anthropic-ai/claude-agent-sdk.
//
// One long-lived `query()` per thread: subprocess + MCP server boot once,
// then each new turn pushes a SDKUserMessage into the same async iterable.
// Cold-start (~10s of node + googleapis import) is paid once per chat
// instead of per-message.
//
// Session continuity: the SDK still persists the transcript to ~/.claude,
// so if a session is recycled (idle timeout / crash), the next message
// resumes from the stored `session_id`.

import type { Database } from 'bun:sqlite';
import {
  query as sdkQuery,
  type McpServerConfig,
  type Query,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { getThreadSession, setThreadSession, clearThreadSession } from '../db.ts';

const PROVIDER_NAME = 'claude';

// How long a session can sit idle before we tear down the subprocess. Next
// message after this will pay cold-start again but resume the transcript.
const IDLE_MS = Number(process.env.NOTHINGCLAW_CLAUDE_IDLE_MS ?? 15 * 60_000);

// SDK errors when `resume: <id>` points at a missing JSONL (purged, different
// machine). Retry once with a fresh session.
const STALE_SESSION_RE = /no conversation found|ENOENT.*\.jsonl|session.*not found/i;

function mcpServers(threadId: string): Record<string, McpServerConfig> {
  return {
    nothingclaw: {
      type: 'stdio',
      command: 'bun',
      args: ['run', 'src/mcp/server.ts'],
      env: {
        ...(process.env as Record<string, string>),
        NOTHINGCLAW_THREAD_ID: threadId,
      },
    },
  };
}

// Push-based async iterable. Each push() queues a turn; the SDK consumes
// them in order and emits a 'result' per turn.
class MessageStream implements AsyncIterable<SDKUserMessage> {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) yield this.queue.shift()!;
      if (this.done) return;
      await new Promise<void>((r) => { this.waiting = r; });
      this.waiting = null;
    }
  }
}

interface Turn {
  resolve: (text: string) => void;
  reject: (err: Error) => void;
}

class ClaudeSession {
  private stream = new MessageStream();
  private query: Query;
  private currentTurn: Turn | null = null;
  private sessionId: string | null;
  private destroyed = false;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(public readonly threadId: string, resumeId: string | null) {
    this.sessionId = resumeId;
    this.query = sdkQuery({
      prompt: this.stream,
      options: {
        cwd: process.cwd(),
        resume: resumeId ?? undefined,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        settingSources: ['project', 'user'],
        mcpServers: mcpServers(threadId),
      },
    });
    void this.consume();
  }

  private async consume(): Promise<void> {
    try {
      for await (const msg of this.query) {
        if (msg.type === 'system' && msg.subtype === 'init') {
          this.sessionId = msg.session_id ?? this.sessionId;
        } else if (msg.type === 'result') {
          this.sessionId = msg.session_id ?? this.sessionId;
          const turn = this.currentTurn;
          this.currentTurn = null;
          if (!turn) continue;
          if (msg.subtype === 'success') {
            turn.resolve(msg.result ?? '');
          } else {
            turn.reject(new Error(`Claude result error: ${msg.errors?.[0] ?? msg.subtype}`));
          }
        }
      }
      // Iterator finished — surface to any pending turn.
      this.currentTurn?.reject(new Error('SDK stream ended unexpectedly'));
      this.currentTurn = null;
      this.destroyed = true;
    } catch (err) {
      this.currentTurn?.reject(err instanceof Error ? err : new Error(String(err)));
      this.currentTurn = null;
      this.destroyed = true;
    }
  }

  isDead(): boolean { return this.destroyed; }
  getSessionId(): string | null { return this.sessionId; }

  send(userText: string, timeoutMs: number): Promise<string> {
    if (this.destroyed) return Promise.reject(new Error('session destroyed'));
    if (this.currentTurn) return Promise.reject(new Error('turn already in flight'));

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.currentTurn) {
          const t = this.currentTurn;
          this.currentTurn = null;
          this.destroy('turn timeout');
          t.reject(new Error('turn timed out'));
        }
      }, timeoutMs);

      this.currentTurn = {
        resolve: (text) => { clearTimeout(timer); this.armIdleTimer(); resolve(text); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      };

      this.stream.push(userText);
    });
  }

  armIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.destroy('idle'), IDLE_MS);
  }

  destroy(reason: string): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    console.log(`[claude] tearing down session ${this.threadId} (${reason})`);
    this.stream.end();
    // Best-effort interrupt — query() may not have an explicit close.
    try { void this.query.interrupt?.(); } catch { /* ignore */ }
  }
}

const sessions = new Map<string, ClaudeSession>();

function shutdown(): void {
  for (const s of sessions.values()) s.destroy('process shutdown');
  sessions.clear();
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

function userFriendlyError(msg: string): string | null {
  if (/QUOTA_EXHAUSTED|exhausted your capacity|quota will reset/i.test(msg)) {
    return `I've hit my daily API quota. Try again later or switch providers.`;
  }
  if (/rate.?limit|RATE_LIMIT|429.*temporarily/i.test(msg)) {
    return `I'm being rate-limited. Try again in a minute.`;
  }
  if (/unauthorized|UNAUTHENTICATED|invalid.*token|expired|authentication_failed/i.test(msg)) {
    return `My API auth expired. Re-run setup or refresh the credentials.`;
  }
  return null;
}

export async function runClaudeSdk(
  db: Database,
  threadId: string,
  userText: string,
  timeoutMs: number,
): Promise<string> {
  const t0 = Date.now();

  let session = sessions.get(threadId);
  if (session && session.isDead()) {
    sessions.delete(threadId);
    session = undefined;
  }
  const isNew = !session;
  if (!session) {
    const prior = getThreadSession(db, threadId, PROVIDER_NAME);
    session = new ClaudeSession(threadId, prior);
    sessions.set(threadId, session);
    console.log(`[claude] start  ${threadId}${prior ? `  (resume ${prior.slice(0, 8)}…)` : ''}`);
  } else {
    console.log(`[claude] turn   ${threadId}`);
  }

  try {
    const text = await session.send(userText, timeoutMs);
    const sid = session.getSessionId();
    if (sid) setThreadSession(db, threadId, PROVIDER_NAME, sid);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`[claude] end    ${threadId}  ${elapsed}s  ${text.length} chars`);
    return text;
  } catch (err) {
    sessions.delete(threadId);
    session.destroy('turn error');

    const msg = err instanceof Error ? err.message : String(err);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

    // First-message stale-session: clear the stored id and retry with a
    // fresh process so the user still gets a reply.
    if (isNew && STALE_SESSION_RE.test(msg)) {
      console.log(`[claude] stale session — clearing and retrying ${threadId}`);
      clearThreadSession(db, threadId);
      return runClaudeSdk(db, threadId, userText, timeoutMs);
    }

    console.error(`[claude] error ${threadId}  ${elapsed}s  ${msg}`);
    return userFriendlyError(msg) ?? '';
  }
}
