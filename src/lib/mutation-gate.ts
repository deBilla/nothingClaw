// Gate for MCP tools that take outbound or mutating actions (send email, write
// Sheets, create calendar events, write-style raw API calls). marsClaw ingests
// untrusted content — email bodies, web pages — so a hijacked or mistaken turn
// must not be able to act as the owner without an explicit allow.
//
// Two modes, selected by config:
//   - mutation_approval = 'off' (default): the all-or-nothing
//     `allow_mutating_tools` flag. Off → refuse; on → run.
//   - mutation_approval = 'all': per-call operator approval. The tool enqueues
//     a broker-authored approval request (structured summary + nonce) to the
//     operator's chat, then blocks until the operator replies the nonce
//     (intercepted before the agent loop) or the window lapses. Approved → run;
//     denied/expired → refuse. See lib/approval-gate.ts.
//
// Enforced inside each tool handler (the MCP server's own code), per the
// canUseTool convention that dangerous MCP tools gate themselves.

import { Database } from 'bun:sqlite';
import { DB_PATH } from '../db/connection.ts';
import { loadConfig } from './config.ts';
import { audit } from './audit-log.ts';
import { enqueueApproval, awaitApproval } from './approval-gate.ts';

const THREAD_ID = process.env.MARSCLAW_THREAD_ID ?? '';

let _db: Database | null = null;
function db(): Database {
  if (!_db) _db = new Database(DB_PATH);
  return _db;
}

export interface ToolRefusal {
  content: { type: 'text'; text: string }[];
  isError: true;
}

function refusalText(text: string): ToolRefusal {
  return { content: [{ type: 'text', text }], isError: true };
}

function flagRefusal(tool: string): ToolRefusal {
  audit({ tool, decision: 'blocked', layer: 'mutation-gate', reason: 'allow_mutating_tools=false' });
  return refusalText(
    `Refused: "${tool}" performs an outbound or mutating action, which is disabled by default. ` +
      `marsClaw blocks these so a hijacked or mistaken turn can't act as the user ` +
      `(send mail, edit or delete their files). ` +
      `Tell the user that to enable it they must set "allow_mutating_tools": true in data/config.json ` +
      `(or MARSCLAW_ALLOW_MUTATING_TOOLS=1) and restart — do not try to edit that file yourself.`,
  );
}

// Queue the action for operator approval and block until resolved. The prompt
// goes through the outbox so the MAIN process delivers it (the broker, not the
// agent, authors it). Returns null when approved (caller proceeds), or a
// refusal when denied/expired.
async function gateByApproval(tool: string, summary: string): Promise<ToolRefusal | null> {
  if (!THREAD_ID) {
    // No thread context (shouldn't happen in normal operation) — fail closed.
    audit({ tool, decision: 'blocked', layer: 'mutation-gate', reason: 'approval: no thread id' });
    return refusalText(`Refused: "${tool}" needs operator approval but no chat thread is in context.`);
  }
  const conn = db();
  const { id, nonce, prompt } = enqueueApproval(conn, THREAD_ID, tool, summary);
  // Deliver the broker-authored prompt via the outbox (same path as send_message).
  conn.query('INSERT INTO outbox (thread_id, text) VALUES (?, ?)').run(THREAD_ID, prompt);
  audit({ tool, decision: 'blocked', layer: 'mutation-gate', subject: nonce, reason: 'awaiting operator approval' });

  const verdict = await awaitApproval(conn, id);
  if (verdict === 'approved') {
    audit({ tool, decision: 'allow', layer: 'mutation-gate', subject: nonce, reason: 'operator approved' });
    return null;
  }
  audit({ tool, decision: 'blocked', layer: 'mutation-gate', subject: nonce, reason: `approval ${verdict}` });
  return refusalText(
    verdict === 'expired'
      ? `Not sent: the approval window passed without confirmation. Ask me again if you still want to do this.`
      : `Not sent: the action was denied.`,
  );
}

/**
 * Gate a tool that is *always* mutating (gmail_send, sheets_write,
 * calendar_create_event). `summary` is a structured, human-readable rendering
 * of the action (composed by the calling tool from its parameters) used in the
 * approval prompt. Returns a ready-to-return MCP refusal when the action is not
 * permitted, or null when it may proceed.
 */
export async function blockIfMutationsDisabled(tool: string, summary?: string): Promise<ToolRefusal | null> {
  const cfg = loadConfig();
  if (cfg.mutation_approval === 'all') {
    return gateByApproval(tool, summary ?? tool);
  }
  return cfg.allow_mutating_tools ? null : flagRefusal(tool);
}

// Leaf-segment verbs that change server-side state. Used to gate the generic
// `*_raw` escape-hatch tools without blocking read-only raw calls — list/get/
// export/query/watch stay allowed even when mutations are off.
const MUTATING_VERB =
  /^(create|insert|update|patch|delete|batchUpdate|append|copy|trash|untrash|move|clear|write|remove|replace|add|set|import|empty|duplicate)/i;

/** True when a dotted googleapis method path (e.g. "events.patch") mutates state. */
export function isMutatingMethod(method: string): boolean {
  const leaf = method.trim().split('.').pop() ?? '';
  return MUTATING_VERB.test(leaf);
}

/**
 * Gate a `*_raw` tool by its method path: blocks only when the method mutates
 * state AND mutations aren't permitted. Read-only methods always pass.
 */
export async function blockIfMutatingMethodDisabled(
  tool: string,
  method: string,
  summary?: string,
): Promise<ToolRefusal | null> {
  if (!isMutatingMethod(method)) return null;
  return blockIfMutationsDisabled(`${tool} (${method})`, summary ?? `${tool}: ${method}`);
}
