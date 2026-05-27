import { spawn } from 'node:child_process';
import type { Database } from 'bun:sqlite';
import { appendMessage, loadHistory, type HistoryRow } from './db/messages.ts';
import type { Channel } from './channels/types.ts';
import { PROVIDERS, pickProvider } from './providers/registry.ts';
import { runClaudeSdk } from './providers/claude-sdk.ts';
import { ClaudeHardError } from './providers/claude-error.ts';
import { startTypingRefresh, stopTypingRefresh, pauseTypingAfterDelivery } from './lib/typing.ts';
import { log } from './lib/log.ts';
import { loadConfig } from './lib/config.ts';
import { buildTurnContext } from './lib/turn-context.ts';

const provider = pickProvider();
const config = loadConfig();
const PROJECT_ROOT = process.cwd();
const HISTORY_TURNS = 20;
const AGENT_TIMEOUT_MS = Number(process.env.MARSCLAW_AGENT_TIMEOUT_MS ?? 300_000);

function buildPrompt(history: HistoryRow[], userText: string, context: string): string {
  const lines: string[] = [];
  if (context) {
    lines.push(context);
    lines.push('');
  }
  if (history.length) {
    lines.push('## Recent conversation');
    for (const m of history) {
      lines.push(`${m.role === 'user' ? 'User' : 'You'}: ${m.text}`);
    }
    lines.push('');
  }
  lines.push('## New message');
  lines.push(`User: ${userText}`);
  lines.push('');
  lines.push('Reply now. Your stdout is sent to the user verbatim as one message.');
  return lines.join('\n');
}

export async function handleMessage(
  db: Database,
  channel: Channel,
  threadId: string,
  userText: string,
): Promise<void> {
  appendMessage(db, threadId, 'user', userText);

  // Ambient per-turn context (current local time, timezone, location). Built
  // fresh each message so the agent always knows "now" and where the user is.
  // Stored history stays raw — we only decorate what's sent to the provider.
  const context = buildTurnContext(config);

  // Begin the "typing…" indicator. The refresher fires every 4s while the
  // agent's heartbeat is fresh, so the user sees activity even on long turns.
  startTypingRefresh(threadId, channel);

  try {
    let response: string;
    if (provider.name === 'claude') {
      // SDK path: session resume keeps the transcript on disk; we only send the
      // new user message (prefixed with ambient context). Sqlite history is
      // still appended for /status etc.
      try {
        response = await runClaudeSdk(db, threadId, `${context}\n\n${userText}`, AGENT_TIMEOUT_MS);
      } catch (err) {
        if (err instanceof ClaudeHardError && PROVIDERS.gemini.isAuthed()) {
          // Claude is out of quota or auth-broken; fall back to Gemini for
          // this turn so the user still gets an answer. Logged so you can
          // see when failover fires.
          log.warn('claude hard error — failing over to gemini', {
            thread: threadId,
            kind: err.kind,
          });
          const history = loadHistory(db, threadId, HISTORY_TURNS);
          const prompt = buildPrompt(history, userText, context);
          response = await runProviderWith(PROVIDERS.gemini, prompt, threadId);
        } else if (err instanceof ClaudeHardError) {
          // No failover available — surface the friendly string.
          response = err.friendly;
        } else {
          throw err;
        }
      }
    } else {
      // Gemini path: no session concept — pass recent history via the prompt.
      const history = loadHistory(db, threadId, HISTORY_TURNS);
      const prompt = buildPrompt(history, userText, context);
      response = await runProvider(prompt, threadId);
    }

    const reply = response.trim();
    if (!reply) {
      console.log(`[agent] ${threadId} produced empty reply — skipping send`);
      return;
    }

    appendMessage(db, threadId, 'assistant', reply);
    await channel.send(threadId, reply);
    pauseTypingAfterDelivery(threadId);
  } finally {
    stopTypingRefresh(threadId);
  }
}

function userFriendlyError(stderr: string): string | null {
  if (/QUOTA_EXHAUSTED|exhausted your capacity|quota will reset/i.test(stderr)) {
    const m = stderr.match(/reset after (\S+)/);
    const when = m ? `in ${m[1].replace(/[^0-9hms]/g, '')}` : 'soon';
    return `I've hit my daily API quota. It resets ${when}. Try switching providers (\`bun run setup\` → claude) or set a paid GEMINI_API_KEY in .env.`;
  }
  if (/rate.?limit|RATE_LIMIT|429.*temporarily/i.test(stderr)) {
    return `I'm being rate-limited. Try again in a minute.`;
  }
  if (/unauthorized|UNAUTHENTICATED|invalid.*token|expired/i.test(stderr)) {
    return `My API auth expired. Your operator needs to re-run setup or refresh the credentials.`;
  }
  return null;
}

function runProvider(prompt: string, threadId: string): Promise<string> {
  return runProviderWith(provider, prompt, threadId);
}

function runProviderWith(
  p: typeof provider,
  prompt: string,
  threadId: string,
): Promise<string> {
  return new Promise((resolveP) => {
    const t0 = Date.now();
    console.log(`[${p.name}] start  ${threadId}`);

    const child = spawn(p.bin, p.buildArgs(prompt), {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        MARSCLAW_THREAD_ID: threadId,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let out = '';
    let err = '';
    let finished = false;

    const timeout = setTimeout(() => {
      if (finished) return;
      console.error(`[${p.name}] timeout after ${AGENT_TIMEOUT_MS}ms — killing ${threadId}`);
      child.kill('SIGTERM');
      setTimeout(() => { if (!child.killed) child.kill('SIGKILL'); }, 2000);
    }, AGENT_TIMEOUT_MS);

    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });

    child.on('error', (e) => {
      finished = true;
      clearTimeout(timeout);
      console.error(`[${p.name}] spawn error`, e);
      resolveP(`(failed to spawn ${p.bin}: ${e.message})`);
    });

    child.on('close', (code) => {
      finished = true;
      clearTimeout(timeout);
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

      if (code !== 0) {
        const friendly = userFriendlyError(err);
        if (friendly) {
          console.error(`[${p.name}] exit ${code} in ${elapsed}s  ${threadId}  → user-facing: ${friendly}`);
          resolveP(friendly);
          return;
        }
        console.error(`[${p.name}] exit ${code} in ${elapsed}s  ${threadId}  stderr=${err.slice(-300).trim()}`);
      } else {
        console.log(`[${p.name}] end    ${threadId}  ${elapsed}s  ${out.length} chars`);
      }
      resolveP(out);
    });
  });
}
