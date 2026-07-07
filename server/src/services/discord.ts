// Best-effort Discord webhook notifications for corp/alliance chain intel.
// Fire-and-forget: never blocks a request and never throws into a caller.
// Scoped to a map's corp OR alliance and configured purely via env (see
// config.ts). See discord_webhooks_feature.md.
import { config } from '../config.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('discord');

// Log the configuration once at startup so a misconfigured DISCORD_WEBHOOK_URL
// is obvious in the logs. URLs are secrets, so we log presence, not values.
{
  const corps      = Object.keys(config.discord.byCorp);
  const alliances  = Object.keys(config.discord.byAlliance);
  const enabled = !!config.discord.defaultUrl || corps.length > 0 || alliances.length > 0;
  log.info(enabled
    ? `enabled — default webhook: ${config.discord.defaultUrl ? 'set' : 'none'}; per-corp overrides: [${corps.join(', ') || 'none'}]; per-alliance overrides: [${alliances.join(', ') || 'none'}]`
    : 'disabled — DISCORD_WEBHOOK_URL is not set (no notifications will be sent)');
}

// The org a map belongs to for Discord routing: a corp OR an alliance (a map is
// never both). Personal maps have both null and never notify.
export interface DiscordScope { corpId: number | null; allianceId: number | null; }

// Resolve the webhook for a map's org: the corp/alliance-specific override
// first, then the shared default, else null (feature off, or a personal map).
export function webhookFor(scope: DiscordScope): string | null {
  if (scope.corpId != null && config.discord.byCorp[scope.corpId]) return config.discord.byCorp[scope.corpId];
  if (scope.allianceId != null && config.discord.byAlliance[scope.allianceId]) return config.discord.byAlliance[scope.allianceId];
  if (scope.corpId != null || scope.allianceId != null) return config.discord.defaultUrl ?? null;
  return null;
}

export interface DiscordEmbed {
  title?:       string;
  description?: string;
  color?:       number;
  fields?:      { name: string; value: string; inline?: boolean }[];
  footer?:      { text: string };
  timestamp?:   string;
}

interface QueueItem { url: string; embed: DiscordEmbed; }

const queue: QueueItem[] = [];
const MAX_QUEUE  = 100;   // drop overflow rather than grow unbounded
const SPACING_MS = 1000;  // gentle pacing — well under Discord's ~30/min limit
let draining = false;

// Enqueue a notification. No-op when no webhook is configured for the scope.
export function notifyDiscord(scope: DiscordScope, embed: DiscordEmbed): void {
  const url = webhookFor(scope);
  if (!url) {
    log.info(`skip "${embed.title}" — no webhook resolved for corpId=${scope.corpId ?? 'null'} / allianceId=${scope.allianceId ?? 'null'}`);
    return;
  }
  if (queue.length >= MAX_QUEUE) {
    log.warn(`queue full (${MAX_QUEUE}) — dropping "${embed.title}"`);
    return;
  }
  queue.push({ url, embed });
  log.info(`queued "${embed.title}" for corpId=${scope.corpId ?? 'null'} / allianceId=${scope.allianceId ?? 'null'} (queue depth: ${queue.length})`);
  void drain();
}

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (queue.length) {
      await deliver(queue.shift()!);
      if (queue.length) await sleep(SPACING_MS);
    }
  } finally {
    draining = false;
  }
}

async function deliver(item: QueueItem, attempt = 0): Promise<void> {
  try {
    const r = await fetch(item.url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ embeds: [item.embed] }),
      signal:  AbortSignal.timeout(5000),
    });
    // Honour Discord's rate-limit backoff a couple of times, then give up.
    if (r.status === 429 && attempt < 2) {
      const body = await r.json().catch(() => ({} as { retry_after?: number }));
      const waitMs = Math.min(5000, Math.round((body.retry_after ?? 1) * 1000) || 1000);
      await sleep(waitMs);
      return deliver(item, attempt + 1);
    }
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      log.warn(`webhook POST failed: ${r.status} ${body.slice(0, 200)}`);
      return;
    }
    log.info(`delivered "${item.embed.title}" (${r.status})`);
  } catch (err) {
    // Timeout / network / Discord down — drop it. Intel is ephemeral; never
    // let a webhook failure bubble into the request path.
    log.warn(`webhook POST error: ${(err as Error).message}`);
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ── Embed builders ──────────────────────────────────────────────────────────
const AMBER = 0xf0a030;
const BLUE  = 0x5b9bff;
const GREEN = 0x3ddc84;

// Saved wormhole chain: name + start/end + how tight and how far.
export function chainEmbed(p: {
  name: string; start: string; end: string; maxSize: string; hops: number; mapName: string; actor: string | null;
}): DiscordEmbed {
  return {
    title:       '🧭 Chain saved',
    description: `**${p.name || `${p.start} → ${p.end}`}** on **${p.mapName}**`,
    color:       GREEN,
    fields: [
      { name: 'From',      value: p.start,          inline: true },
      { name: 'To',        value: p.end,            inline: true },
      { name: 'Max ship',  value: p.maxSize,        inline: true },
      { name: 'Hops',      value: String(p.hops),   inline: true },
    ],
    footer:    p.actor ? { text: `saved by ${p.actor}` } : undefined,
    timestamp: new Date().toISOString(),
  };
}

export function k162Embed(p: {
  system: string; systemClass: string; leadsTo?: string | null; mapName: string; actor: string | null;
}): DiscordEmbed {
  const fields: NonNullable<DiscordEmbed['fields']> = [];
  if (p.leadsTo) fields.push({ name: 'Leads to', value: p.leadsTo, inline: true });
  return {
    title:       '⚠️ Inbound K162',
    description: `New **K162** in **${p.system}** (${p.systemClass}) — something just connected into **${p.mapName}**.`,
    color:       AMBER,
    fields:      fields.length ? fields : undefined,
    footer:      p.actor ? { text: `set by ${p.actor}` } : undefined,
    timestamp:   new Date().toISOString(),
  };
}

export function connectionEmbed(p: {
  a: string; b: string; whType: string | null; size: string | null; mapName: string; actor: string | null;
}): DiscordEmbed {
  const fields: NonNullable<DiscordEmbed['fields']> = [];
  if (p.whType) fields.push({ name: 'Type', value: p.whType, inline: true });
  if (p.size)   fields.push({ name: 'Size', value: p.size,   inline: true });
  return {
    title:       '🔗 New connection',
    description: `**${p.a}** ↔ **${p.b}** on **${p.mapName}**`,
    color:       BLUE,
    fields:      fields.length ? fields : undefined,
    footer:      p.actor ? { text: `added by ${p.actor}` } : undefined,
    timestamp:   new Date().toISOString(),
  };
}
