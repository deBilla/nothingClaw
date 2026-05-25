// MCP tools: Google Sheets. Read a range, write/append to a range, plus raw.

import { sheetsClient } from '../google/clients.ts';
import { callMethodPath, rawToolDescription, summarize } from '../google/raw.ts';

function errMsg(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/No stored credentials|No Google accounts/.test(msg)) return `Sheets not connected: ${msg}`;
  return `Sheets error: ${msg}`;
}

const accountProp = {
  account: {
    type: 'string',
    description: 'Google account alias (from google_accounts). Omit to use the default.',
  },
};

export const sheetsReadTool = {
  definition: {
    name: 'sheets_read',
    description:
      'Read cell values from a Google Sheet range. Range uses A1 notation (e.g. "Sheet1!A1:D20", "Q2!B:B"). Returns a 2D array of values.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        spreadsheet_id: { type: 'string', description: 'Spreadsheet id (from URL or drive_search).' },
        range: { type: 'string', description: 'A1-notation range, e.g. "Sheet1!A1:D20".' },
        ...accountProp,
      },
      required: ['spreadsheet_id', 'range'],
    },
  },

  async handler(args: Record<string, unknown>) {
    const id = String(args.spreadsheet_id ?? '').trim();
    const range = String(args.range ?? '').trim();
    const account = args.account ? String(args.account) : undefined;
    if (!id || !range) {
      return { content: [{ type: 'text', text: 'Error: spreadsheet_id and range are required' }], isError: true };
    }
    try {
      const s = sheetsClient(account);
      const res = await s.spreadsheets.values.get({ spreadsheetId: id, range });
      return { content: [{ type: 'text', text: summarize(res.data.values ?? []) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: errMsg(err) }], isError: true };
    }
  },
};

export const sheetsWriteTool = {
  definition: {
    name: 'sheets_write',
    description:
      'Write a 2D array of values into a Google Sheet range. `mode` is "overwrite" (default — uses values.update on the exact range) or "append" (uses values.append to add new rows after existing data). Range uses A1 notation.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        spreadsheet_id: { type: 'string', description: 'Spreadsheet id.' },
        range: { type: 'string', description: 'A1-notation range. For append, the sheet name suffices (e.g. "Sheet1").' },
        values: {
          type: 'array',
          description: '2D array of cell values (rows of columns).',
          items: { type: 'array', items: {} },
        },
        mode: {
          type: 'string',
          enum: ['overwrite', 'append'],
          description: 'overwrite = values.update, append = values.append. Default overwrite.',
        },
        value_input_option: {
          type: 'string',
          enum: ['RAW', 'USER_ENTERED'],
          description: 'How input is parsed. USER_ENTERED treats inputs like a user typing (formulas evaluated, dates parsed). Default USER_ENTERED.',
        },
        ...accountProp,
      },
      required: ['spreadsheet_id', 'range', 'values'],
    },
  },

  async handler(args: Record<string, unknown>) {
    const id = String(args.spreadsheet_id ?? '').trim();
    const range = String(args.range ?? '').trim();
    const values = args.values as unknown[][];
    const mode = String(args.mode ?? 'overwrite');
    const valueInputOption = String(args.value_input_option ?? 'USER_ENTERED');
    const account = args.account ? String(args.account) : undefined;
    if (!id || !range || !Array.isArray(values)) {
      return {
        content: [{ type: 'text', text: 'Error: spreadsheet_id, range, values (2D array) are required' }],
        isError: true,
      };
    }
    try {
      const s = sheetsClient(account);
      if (mode === 'append') {
        const res = await s.spreadsheets.values.append({
          spreadsheetId: id,
          range,
          valueInputOption,
          requestBody: { values },
        });
        return { content: [{ type: 'text', text: `Appended ${res.data.updates?.updatedCells ?? 0} cells.` }] };
      }
      const res = await s.spreadsheets.values.update({
        spreadsheetId: id,
        range,
        valueInputOption,
        requestBody: { values },
      });
      return { content: [{ type: 'text', text: `Updated ${res.data.updatedCells ?? 0} cells in ${res.data.updatedRange}.` }] };
    } catch (err) {
      return { content: [{ type: 'text', text: errMsg(err) }], isError: true };
    }
  },
};

export const sheetsRawTool = {
  definition: {
    name: 'sheets_raw',
    description: rawToolDescription(
      'Sheets',
      '`spreadsheets.create` for new sheets, `spreadsheets.batchUpdate` for formatting/structure changes (addSheet, mergeCells, conditional format), `spreadsheets.get` for full metadata',
    ),
    inputSchema: {
      type: 'object' as const,
      properties: {
        method: { type: 'string', description: 'Dotted method path, e.g. "spreadsheets.batchUpdate".' },
        params: { type: 'object', description: 'Params object passed to the googleapis call.' },
        ...accountProp,
      },
      required: ['method', 'params'],
    },
  },

  async handler(args: Record<string, unknown>) {
    const method = String(args.method ?? '').trim();
    const params = (args.params ?? {}) as Record<string, unknown>;
    const account = args.account ? String(args.account) : undefined;
    if (!method) return { content: [{ type: 'text', text: 'Error: method is required' }], isError: true };
    try {
      const data = await callMethodPath(sheetsClient(account), method, params);
      return { content: [{ type: 'text', text: summarize(data) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: errMsg(err) }], isError: true };
    }
  },
};
