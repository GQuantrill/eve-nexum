// Best-effort Discord webhook notifications for corp/alliance chain intel.
// Fire-and-forget: never blocks a request and never throws into a caller.
// Webhook URLs are per-org, per-event-type, and stored in the discord settings
// tables (managed in the admin UI). See discord_webhooks_feature.md.
import { createLogger } from '../utils/logger.js';

const log = createLogger('discord');

// SSRF guard: the server POSTs to an admin-supplied URL, so it must be a genuine
// Discord webhook endpoint. Validated on write (admin PUT / env seed) AND before
// every send, so a stored value can never point the server at an internal host.
const DISCORD_WEBHOOK_HOSTS = new Set([
  'discord.com', 'discordapp.com', 'ptb.discord.com', 'canary.discord.com',
]);
export function isDiscordWebhookUrl(url: unknown): url is string {
  if (typeof url !== 'string' || !url) return false;
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  return u.protocol === 'https:'
    && DISCORD_WEBHOOK_HOSTS.has(u.hostname)
    && u.pathname.startsWith('/api/webhooks/');
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

// Enqueue a notification to a specific webhook URL. No-op when the URL is
// absent (event type not configured for this org) or not a valid Discord
// webhook (SSRF guard — never POST to an arbitrary host).
export function notifyDiscord(url: string | null | undefined, embed: DiscordEmbed): void {
  if (!url) {
    log.info(`skip "${embed.title}" — no webhook configured for this event`);
    return;
  }
  if (!isDiscordWebhookUrl(url)) {
    log.warn(`skip "${embed.title}" — stored webhook is not a valid Discord webhook URL`);
    return;
  }
  if (queue.length >= MAX_QUEUE) {
    log.warn(`queue full (${MAX_QUEUE}) — dropping "${embed.title}"`);
    return;
  }
  queue.push({ url, embed });
  log.info(`queued "${embed.title}" (queue depth: ${queue.length})`);
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
      method:   'POST',
      headers:  { 'Content-Type': 'application/json' },
      body:     JSON.stringify({ embeds: [item.embed] }),
      signal:   AbortSignal.timeout(5000),
      // The URL host is allowlisted to Discord, but a 3xx could otherwise bounce
      // the POST to an arbitrary host — refuse to follow redirects (SSRF guard).
      redirect: 'error',
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
const RED   = 0xe05a5a;

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

// Richer form of the new-connection notification for a freshly revealed k-space
// exit reachable from the map's home: the security band, the chain path out to
// it, and how far the nearest trade hub is by stargate. Same connections
// webhook as connectionEmbed — just a routing-intel layout when the intel exists.
export function kspaceExitEmbed(p: {
  exitName: string; exitRegion: string | null; exitSecurity: number;
  connectedName: string; connectedClass: string;
  pathNames: string[]; whJumps: number; gateJumps: number;
  hubName: string | null; hubJumps: number | null; total: number;
  mapName: string; actor: string | null;
}): DiscordEmbed {
  // Security-band aware title + colour: highsec reads safe (green), lowsec
  // caution (amber), nullsec danger (red).
  const title = p.exitSecurity >= 0.45 ? '🚨 Highsec Exit Found'
              : p.exitSecurity >  0.0  ? '🚨 Lowsec Exit Found'
              :                          '🚨 Nullsec Exit Found';
  const color = p.exitSecurity >= 0.45 ? GREEN
              : p.exitSecurity >  0.0  ? AMBER
              :                          RED;
  const fields: NonNullable<DiscordEmbed['fields']> = [
    { name: 'Exit system',  value: `${p.exitName} (${p.exitRegion ?? '?'}) — Security ${p.exitSecurity.toFixed(1)}`, inline: true },
    { name: 'Connected to', value: `${p.connectedName} (${p.connectedClass})`, inline: true },
    { name: 'Path from home',           value: p.pathNames.join(' → ') },
    { name: 'Wormhole jumps from home', value: String(p.whJumps), inline: true },
  ];
  if (p.hubName != null) {
    fields.push({ name: 'Nearest trade hub', value: `${p.hubName} — ${p.hubJumps} stargate jumps from exit`, inline: true });
  }
  if (p.hubJumps != null) {
    // Stargate portion = in-chain gate/Ansiblex hops + the exit→hub gate route.
    const stargate = p.gateJumps + p.hubJumps;
    fields.push({ name: 'Total effective distance', value: `${p.whJumps} WH + ${stargate} stargate = ${p.total} jumps` });
  }
  return {
    title,
    description: `**${p.exitName}** exit found on **${p.mapName}**`,
    color,
    fields,
    footer:    p.actor ? { text: `mapped by ${p.actor}` } : undefined,
    timestamp: new Date().toISOString(),
  };
}
