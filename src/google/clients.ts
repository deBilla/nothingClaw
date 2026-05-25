// Authed Google API clients, one factory per service. Each accepts an
// optional account alias; omit it to use the default account.

import { google } from 'googleapis';
import { getAuthedClient } from './auth.ts';

export const gmailClient = (account?: string) => google.gmail({ version: 'v1', auth: getAuthedClient(account) });
export const calendarClient = (account?: string) => google.calendar({ version: 'v3', auth: getAuthedClient(account) });
export const driveClient = (account?: string) => google.drive({ version: 'v3', auth: getAuthedClient(account) });
export const sheetsClient = (account?: string) => google.sheets({ version: 'v4', auth: getAuthedClient(account) });
export const docsClient = (account?: string) => google.docs({ version: 'v1', auth: getAuthedClient(account) });
export const slidesClient = (account?: string) => google.slides({ version: 'v1', auth: getAuthedClient(account) });
