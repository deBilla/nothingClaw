// MCP tools: Google Slides. Text-only read of a deck + raw escape hatch.

import { slidesClient } from '../google/clients.ts';
import { callMethodPath, rawToolDescription, summarize } from '../google/raw.ts';
import { blockIfMutatingMethodDisabled } from '../lib/mutation-gate.ts';

function errMsg(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/No stored credentials|No Google accounts/.test(msg)) return `Slides not connected: ${msg}`;
  return `Slides error: ${msg}`;
}

const accountProp = {
  account: {
    type: 'string',
    description: 'Google account alias (from google_accounts). Omit to use the default.',
  },
};

interface SlideElement {
  shape?: {
    text?: {
      textElements?: Array<{ textRun?: { content?: string | null } | null }> | null;
    } | null;
  } | null;
  table?: {
    tableRows?: Array<{
      tableCells?: Array<{
        text?: { textElements?: Array<{ textRun?: { content?: string | null } | null }> | null } | null;
      }> | null;
    }> | null;
  } | null;
}

function textFromElements(elements: SlideElement[] | null | undefined): string {
  if (!elements) return '';
  const out: string[] = [];
  for (const el of elements) {
    if (el.shape?.text?.textElements) {
      for (const t of el.shape.text.textElements) {
        if (t.textRun?.content) out.push(t.textRun.content);
      }
    }
    if (el.table?.tableRows) {
      for (const row of el.table.tableRows) {
        for (const cell of row.tableCells ?? []) {
          for (const t of cell.text?.textElements ?? []) {
            if (t.textRun?.content) out.push(t.textRun.content);
          }
        }
      }
    }
  }
  return out.join('');
}

export const slidesReadTool = {
  definition: {
    name: 'slides_read',
    description:
      'Read a Google Slides deck as plain text, slide by slide. Returns slide id and concatenated text from shapes/tables. Skips images. For edits use slides_raw with presentations.batchUpdate.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        presentation_id: { type: 'string', description: 'Google Slides id (from URL or drive_search).' },
        ...accountProp,
      },
      required: ['presentation_id'],
    },
  },

  async handler(args: Record<string, unknown>) {
    const id = String(args.presentation_id ?? '').trim();
    const account = args.account ? String(args.account) : undefined;
    if (!id) {
      return { content: [{ type: 'text', text: 'Error: presentation_id is required' }], isError: true };
    }
    try {
      const c = slidesClient(account);
      const res = await c.presentations.get({ presentationId: id });
      const title = res.data.title ?? id;
      const slides = res.data.slides ?? [];
      const parts: string[] = [`# ${title} (${slides.length} slides)`];
      slides.forEach((s, i) => {
        const text = textFromElements(s.pageElements as SlideElement[] | null | undefined).trim();
        parts.push(`\n## Slide ${i + 1} (${s.objectId})\n${text || '(no text)'}`);
      });
      return { content: [{ type: 'text', text: parts.join('\n') }] };
    } catch (err) {
      return { content: [{ type: 'text', text: errMsg(err) }], isError: true };
    }
  },
};

export const slidesRawTool = {
  definition: {
    name: 'slides_raw',
    description: rawToolDescription(
      'Slides',
      '`presentations.create` to make a new deck, `presentations.batchUpdate` to apply edits (createSlide, insertText, replaceAllText, createShape, deleteObject) — pass `{ presentationId, requestBody: { requests: [...] } }`',
    ),
    inputSchema: {
      type: 'object' as const,
      properties: {
        method: { type: 'string', description: 'Dotted method path, e.g. "presentations.batchUpdate".' },
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
    const blocked = await blockIfMutatingMethodDisabled('slides_raw', method);
    if (blocked) return blocked;
    try {
      const data = await callMethodPath(slidesClient(account), method, params);
      return { content: [{ type: 'text', text: summarize(data) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: errMsg(err) }], isError: true };
    }
  },
};
