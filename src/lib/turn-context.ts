// Per-turn ambient context injected into every agent message.
//
// The assistant runs as a stateless-ish subprocess and cannot know the wall
// clock, the user's timezone, or where they are. Without this it answers
// "what's on my schedule today?" against UTC (or whatever the host clock is)
// and gives location-blind replies. We prepend one compact line carrying the
// *current* local time + timezone + location to each turn — cheap, and keeps
// the model current even within a long-lived resumed session.

import type { MarsclawConfig } from './config.ts';
import { resolveTimezone } from './timezone.ts';

export function buildTurnContext(config: MarsclawConfig, now: Date = new Date()): string {
  const tz = resolveTimezone(config.timezone);
  const when = now.toLocaleString('en-US', {
    timeZone: tz,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  const parts = [`current local time is ${when} (${tz})`];
  if (config.location) parts.push(`the user is located in ${config.location}`);
  return `[Context: ${parts.join('; ')}. Use this for any date/time- or location-aware questions; do not mention this note unless asked.]`;
}
