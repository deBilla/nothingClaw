// Gmail helpers used by the CLI and MCP tools. All take an optional account
// alias; omit to use the default account.

import { gmailClient } from './clients.ts';

export interface MessageMeta {
  id: string;
  from: string;
  to: string;
  date: string;
  subject: string;
  snippet: string;
}

export interface MessageFull extends MessageMeta {
  body: string;
}

export async function listRecent(max = 10, account?: string): Promise<MessageMeta[]> {
  return search(undefined, max, account);
}

export async function search(
  query: string | undefined,
  max = 10,
  account?: string,
): Promise<MessageMeta[]> {
  const g = gmailClient(account);
  const list = await g.users.messages.list({
    userId: 'me',
    maxResults: max,
    ...(query ? { q: query } : {}),
  });
  const ids = (list.data.messages ?? []).map((m) => m.id!).filter(Boolean);

  return Promise.all(
    ids.map(async (id) => {
      const msg = await g.users.messages.get({
        userId: 'me',
        id,
        format: 'metadata',
        metadataHeaders: ['From', 'To', 'Subject', 'Date'],
      });
      return toMeta(id, msg.data);
    }),
  );
}

export async function getMessage(id: string, account?: string): Promise<MessageFull> {
  const g = gmailClient(account);
  const msg = await g.users.messages.get({ userId: 'me', id, format: 'full' });
  return { ...toMeta(id, msg.data), body: extractBody(msg.data.payload) };
}

function toMeta(
  id: string,
  data: {
    payload?: { headers?: Array<{ name?: string | null; value?: string | null }> | null } | null;
    snippet?: string | null;
  },
): MessageMeta {
  const headers = data.payload?.headers ?? [];
  const h = (n: string) =>
    headers.find((x) => x.name?.toLowerCase() === n.toLowerCase())?.value ?? '';
  return {
    id,
    from: h('From'),
    to: h('To'),
    date: h('Date'),
    subject: h('Subject'),
    snippet: data.snippet ?? '',
  };
}

interface Part {
  mimeType?: string | null;
  body?: { data?: string | null } | null;
  parts?: Part[] | null;
}

function extractBody(payload: Part | null | undefined): string {
  if (!payload) return '';
  const text = findPart(payload, 'text/plain');
  if (text) return decode(text);
  const html = findPart(payload, 'text/html');
  if (html) return stripHtml(decode(html));
  return '';
}

function findPart(part: Part, mime: string): string | null {
  if (part.mimeType === mime && part.body?.data) return part.body.data;
  for (const sub of part.parts ?? []) {
    const hit = findPart(sub, mime);
    if (hit) return hit;
  }
  return null;
}

function decode(b64url: string): string {
  return Buffer.from(b64url.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
