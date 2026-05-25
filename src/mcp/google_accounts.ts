// MCP tool: enumerate the user's connected Google accounts so the agent can
// pick a sensible `account` argument for Gmail/Calendar/Drive/Sheets/Docs/Slides
// when the user is ambiguous ("check my work calendar").

import { listAccounts, storedScopes } from '../google/auth.ts';

export const googleAccountsTool = {
  definition: {
    name: 'google_accounts',
    description:
      'List the user\'s connected Google account aliases. Use this to discover the value to pass as `account` to any other google_* / gmail_* / calendar_* / drive_* / sheets_* / docs_* / slides_* tool. Omitting `account` uses the default account.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },

  async handler() {
    const idx = listAccounts();
    if (idx.accounts.length === 0) {
      return {
        content: [
          { type: 'text', text: 'No Google accounts connected. Ask the user to run: `bun run google login [alias]`.' },
        ],
      };
    }
    const lines = idx.accounts.map((a) => {
      const scopes = storedScopes(a);
      const star = a === idx.default ? ' (default)' : '';
      return `- ${a}${star}\n    scopes: ${scopes.length ? scopes.join(', ') : '(none)'}`;
    });
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  },
};
