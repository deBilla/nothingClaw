-- Per-call mutation approval (chat-native, NemoClaw-style).
--
-- A mutating MCP tool (gmail_send, calendar_create_event, *_raw writes, …)
-- inserts a row here instead of acting, sends a broker-authored prompt to the
-- operator, and polls this row for the verdict. The operator's nonce reply is
-- intercepted in the main process before the agent loop and flips status to
-- 'approved'. The agent can neither author the prompt nor see the reply.
CREATE TABLE IF NOT EXISTS pending_approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  tool TEXT NOT NULL,
  summary TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'denied', 'expired')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS pending_approvals_lookup_idx ON pending_approvals(thread_id, status);
