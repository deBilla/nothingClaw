// MCP tools: Google Calendar. Read+write via two common operations
// (list, create) plus a generic raw escape hatch for everything else.

import { calendarClient } from '../google/clients.ts';
import { callMethodPath, rawToolDescription, summarize } from '../google/raw.ts';

function errMsg(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/No stored credentials|No Google accounts/.test(msg)) return `Calendar not connected: ${msg}`;
  return `Calendar error: ${msg}`;
}

const accountProp = {
  account: {
    type: 'string',
    description: 'Google account alias (from google_accounts). Omit to use the default.',
  },
};

export const calendarListTool = {
  definition: {
    name: 'calendar_list_events',
    description:
      'List events on a Google Calendar within a time range. Defaults: primary calendar, next 7 days. Returns id, summary, start, end, attendees, location.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        calendar_id: { type: 'string', description: 'Calendar id (default "primary").' },
        time_min: { type: 'string', description: 'RFC3339 lower bound (e.g. 2026-05-25T00:00:00Z). Defaults to now.' },
        time_max: { type: 'string', description: 'RFC3339 upper bound. Defaults to now + 7 days.' },
        q: { type: 'string', description: 'Free-text search across event fields.' },
        max: { type: 'number', description: 'How many events (default 20, max 100).' },
        ...accountProp,
      },
    },
  },

  async handler(args: Record<string, unknown>) {
    const account = args.account ? String(args.account) : undefined;
    const calendarId = args.calendar_id ? String(args.calendar_id) : 'primary';
    const timeMin = args.time_min ? String(args.time_min) : new Date().toISOString();
    const timeMax = args.time_max
      ? String(args.time_max)
      : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const max = clamp(Number(args.max ?? 20), 1, 100);
    const q = args.q ? String(args.q) : undefined;
    try {
      const c = calendarClient(account);
      const res = await c.events.list({
        calendarId,
        timeMin,
        timeMax,
        singleEvents: true,
        orderBy: 'startTime',
        maxResults: max,
        ...(q ? { q } : {}),
      });
      const items = res.data.items ?? [];
      if (items.length === 0) {
        return { content: [{ type: 'text', text: '(no events)' }] };
      }
      const lines = items.map((e) => {
        const start = e.start?.dateTime ?? e.start?.date ?? '?';
        const end = e.end?.dateTime ?? e.end?.date ?? '?';
        const who = (e.attendees ?? []).map((a) => a.email).filter(Boolean).join(', ');
        return `${e.id}  ${e.summary || '(no title)'}\n    ${start} → ${end}${
          e.location ? ` @ ${e.location}` : ''
        }${who ? `\n    attendees: ${who}` : ''}`;
      });
      return { content: [{ type: 'text', text: lines.join('\n\n') }] };
    } catch (err) {
      return { content: [{ type: 'text', text: errMsg(err) }], isError: true };
    }
  },
};

export const calendarCreateTool = {
  definition: {
    name: 'calendar_create_event',
    description:
      'Create a new event on a Google Calendar. Provide RFC3339 start/end (or date-only for all-day). Returns the created event id and HTML link.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        summary: { type: 'string', description: 'Event title.' },
        start: { type: 'string', description: 'RFC3339 datetime (with offset) or YYYY-MM-DD for all-day.' },
        end: { type: 'string', description: 'RFC3339 datetime or YYYY-MM-DD for all-day. Must match start type.' },
        description: { type: 'string', description: 'Optional event body.' },
        location: { type: 'string', description: 'Optional location.' },
        attendees: {
          type: 'array',
          description: 'Optional list of attendee email addresses.',
          items: { type: 'string' },
        },
        calendar_id: { type: 'string', description: 'Calendar id (default "primary").' },
        ...accountProp,
      },
      required: ['summary', 'start', 'end'],
    },
  },

  async handler(args: Record<string, unknown>) {
    const account = args.account ? String(args.account) : undefined;
    const calendarId = args.calendar_id ? String(args.calendar_id) : 'primary';
    const summary = String(args.summary ?? '').trim();
    const start = String(args.start ?? '').trim();
    const end = String(args.end ?? '').trim();
    if (!summary || !start || !end) {
      return { content: [{ type: 'text', text: 'Error: summary, start, end are required' }], isError: true };
    }
    const isAllDay = /^\d{4}-\d{2}-\d{2}$/.test(start);
    const startObj = isAllDay ? { date: start } : { dateTime: start };
    const endObj = isAllDay ? { date: end } : { dateTime: end };
    const attendees = Array.isArray(args.attendees)
      ? (args.attendees as unknown[]).map((a) => ({ email: String(a) }))
      : undefined;

    try {
      const c = calendarClient(account);
      const res = await c.events.insert({
        calendarId,
        requestBody: {
          summary,
          ...(args.description ? { description: String(args.description) } : {}),
          ...(args.location ? { location: String(args.location) } : {}),
          start: startObj,
          end: endObj,
          ...(attendees ? { attendees } : {}),
        },
      });
      const ev = res.data;
      return { content: [{ type: 'text', text: `Created: ${ev.id}\n${ev.htmlLink ?? ''}` }] };
    } catch (err) {
      return { content: [{ type: 'text', text: errMsg(err) }], isError: true };
    }
  },
};

export const calendarRawTool = {
  definition: {
    name: 'calendar_raw',
    description: rawToolDescription(
      'Calendar',
      '`events.patch` to update an event, `events.delete` to remove one, `calendarList.list` to enumerate calendars, `freebusy.query` for availability',
    ),
    inputSchema: {
      type: 'object' as const,
      properties: {
        method: { type: 'string', description: 'Dotted method path, e.g. "events.patch".' },
        params: { type: 'object', description: 'Params object passed straight to the googleapis call.' },
        ...accountProp,
      },
      required: ['method', 'params'],
    },
  },

  async handler(args: Record<string, unknown>) {
    const method = String(args.method ?? '').trim();
    const params = (args.params ?? {}) as Record<string, unknown>;
    const account = args.account ? String(args.account) : undefined;
    if (!method) {
      return { content: [{ type: 'text', text: 'Error: method is required' }], isError: true };
    }
    try {
      const data = await callMethodPath(calendarClient(account), method, params);
      return { content: [{ type: 'text', text: summarize(data) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: errMsg(err) }], isError: true };
    }
  },
};

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}
