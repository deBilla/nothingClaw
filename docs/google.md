# Google integration

A small suite of MCP tools lets the agent talk to your Google account: Gmail, Calendar, Contacts, Drive, Sheets, Docs, Slides. OAuth tokens live in the macOS Keychain (or 0600 files on Linux), never on disk in plaintext or in `.env`.

## One-time setup

1. Go to [console.cloud.google.com/apis/credentials](https://console.cloud.google.com/apis/credentials).
2. **Create credentials → OAuth client ID → Desktop app.**
3. Copy the client ID + secret into `.env`:
   ```env
   GOOGLE_OAUTH_CLIENT_ID=…
   GOOGLE_OAUTH_CLIENT_SECRET=…
   ```
4. Enable the APIs you'll use (Gmail, Calendar, Drive, Sheets, Docs, Slides, People).
5. Add yourself as a test user under the OAuth consent screen (or publish the app).
6. Log in:
   ```bash
   bun run google login            # default account
   bun run google login work       # named alias
   ```

The browser will pop up; finish the consent flow. A refresh token is stored in Keychain under `google-refresh-token:<alias>`.

## Multiple accounts

```bash
bun run google login personal
bun run google login work
bun run google status        # which accounts are linked, which is default
bun run google logout work   # forget one
bun run google test          # smoke-check the default account
```

All MCP tools accept an optional `account` argument; if omitted the default alias is used.

## Available tools

Defined in [src/mcp/](https://github.com/deBilla/marsclaw/blob/main/src/mcp/). The agent sees them automatically because the MCP server is wired up in [.mcp.json](https://github.com/deBilla/marsclaw/blob/main/.mcp.json).

| Tool | Source | What it does |
|---|---|---|
| `gmail_recent`     | [gmail.ts](https://github.com/deBilla/marsclaw/blob/main/src/mcp/gmail.ts)    | List recent inbox messages |
| `gmail_search`     | [gmail.ts](https://github.com/deBilla/marsclaw/blob/main/src/mcp/gmail.ts)    | Search Gmail with the standard query language |
| `gmail_get`        | [gmail.ts](https://github.com/deBilla/marsclaw/blob/main/src/mcp/gmail.ts)    | Fetch a specific message (headers + body) |
| `gmail_send`       | [gmail.ts](https://github.com/deBilla/marsclaw/blob/main/src/mcp/gmail.ts)    | Compose and send |
| `contacts_search`  | [contacts.ts](https://github.com/deBilla/marsclaw/blob/main/src/mcp/contacts.ts) | Resolve a name to email/phone |
| `calendar_list_events` | [calendar.ts](https://github.com/deBilla/marsclaw/blob/main/src/mcp/calendar.ts) | List events in a time range |
| `calendar_create_event` | [calendar.ts](https://github.com/deBilla/marsclaw/blob/main/src/mcp/calendar.ts) | Create an event |
| `calendar_raw`     | [calendar.ts](https://github.com/deBilla/marsclaw/blob/main/src/mcp/calendar.ts) | Raw HTTP escape hatch to the Calendar API |
| `drive_search`     | [drive.ts](https://github.com/deBilla/marsclaw/blob/main/src/mcp/drive.ts)    | Search Drive by name/mime/owner |
| `drive_read`       | [drive.ts](https://github.com/deBilla/marsclaw/blob/main/src/mcp/drive.ts)    | Read a file's content (export as text if it's a Google doc) |
| `drive_raw`        | [drive.ts](https://github.com/deBilla/marsclaw/blob/main/src/mcp/drive.ts)    | Raw HTTP escape hatch |
| `sheets_read`      | [sheets.ts](https://github.com/deBilla/marsclaw/blob/main/src/mcp/sheets.ts)  | Read a range of cells |
| `sheets_write`     | [sheets.ts](https://github.com/deBilla/marsclaw/blob/main/src/mcp/sheets.ts)  | Write a range of cells |
| `sheets_raw`       | [sheets.ts](https://github.com/deBilla/marsclaw/blob/main/src/mcp/sheets.ts)  | Raw HTTP escape hatch |
| `docs_read`        | [docs.ts](https://github.com/deBilla/marsclaw/blob/main/src/mcp/docs.ts)      | Read a Google Doc as text |
| `docs_raw`         | [docs.ts](https://github.com/deBilla/marsclaw/blob/main/src/mcp/docs.ts)      | Raw HTTP escape hatch |
| `slides_read`      | [slides.ts](https://github.com/deBilla/marsclaw/blob/main/src/mcp/slides.ts)  | Read a Google Slides deck |
| `slides_raw`       | [slides.ts](https://github.com/deBilla/marsclaw/blob/main/src/mcp/slides.ts)  | Raw HTTP escape hatch |
| `google_accounts`  | [google_accounts.ts](https://github.com/deBilla/marsclaw/blob/main/src/mcp/google_accounts.ts) | List linked aliases + default |

Each "raw" tool is a thin pass-through to the underlying Google API endpoint with auth bolted on. They exist so the agent can do things we haven't wrapped — sending an HTTP path + body — without you having to add a new TypeScript tool.

## Scopes

Scopes granted per account are stored alongside the refresh token (`google-scopes:<alias>`). Adding a new tool may require re-logging in to grant new scopes:

```bash
bun run google logout personal
bun run google login personal
```

## Security model

- Refresh tokens never enter `.env` or the SQLite DB.
- The MCP server receives only the OAuth **client** ID/secret via env passthrough — the refresh token is read from Keychain on demand inside the tool handler.
- Access tokens are fetched from Google at call time, used once, discarded.
- The token storage layer ([src/google/keychain.ts](https://github.com/deBilla/marsclaw/blob/main/src/google/keychain.ts)) prefers macOS `security` CLI; on Linux it falls back to `~/.config/marsclaw/secrets/<key>` with mode 0600.

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| `invalid_grant` | Refresh token revoked (you removed access from [myaccount.google.com/permissions](https://myaccount.google.com/permissions)) | `bun run google login <alias>` |
| `insufficient_scope` | Tool needs a scope you didn't grant | logout + login again |
| `Quota exceeded` | Daily project-level quota in Google Cloud | Bump quota in console, or wait |
| `No default account` | Never logged in | `bun run google login` |
| Tool can't find an alias | Typo / not logged in | `bun run google status` |
