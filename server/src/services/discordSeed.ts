// One-time migration of the legacy DISCORD_WEBHOOK_URL env into the per-org,
// per-event-type webhook columns. Runs on every boot but only ever FILLS NULLS
// (COALESCE keeps any admin-set value), so it's idempotent and safe to keep
// running until the operator deletes the env var. Once DISCORD_WEBHOOK_URL is
// unset, this no-ops entirely.
//
// Legacy env forms (comma-separated): a bare URL (default for every corp AND
// alliance), "corpId=URL", or "a<allianceId>=URL". The seeded value goes into
// BOTH the connections and chains webhook for the target org.
import { db } from '../db.js';
import { config } from '../config.js';
import { isDiscordWebhookUrl } from './discord.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('discordSeed');

function parseLegacyEnv(raw: string | undefined): { defaultUrl: string | null; byCorp: Map<number, string>; byAlliance: Map<number, string> } {
  const byCorp = new Map<number, string>();
  const byAlliance = new Map<number, string>();
  let defaultUrl: string | null = null;
  for (const entry of (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    if (/^https?:\/\//i.test(entry)) { defaultUrl = entry; continue; }
    const eq = entry.indexOf('=');
    if (eq <= 0) continue;
    const key = entry.slice(0, eq).trim();
    const url = entry.slice(eq + 1).trim();
    const isAlliance = /^a\d+$/i.test(key);
    const id = parseInt(isAlliance ? key.slice(1) : key, 10);
    if (!Number.isInteger(id) || id <= 0) continue;
    (isAlliance ? byAlliance : byCorp).set(id, url);
  }
  return { defaultUrl, byCorp, byAlliance };
}

async function fillCorp(corpId: number, url: string): Promise<void> {
  await db.query(
    `INSERT INTO corp_discord_settings (corp_id, connections_webhook, chains_webhook, updated_at)
     VALUES ($1, $2, $2, NOW())
     ON CONFLICT (corp_id) DO UPDATE
       SET connections_webhook = COALESCE(corp_discord_settings.connections_webhook, EXCLUDED.connections_webhook),
           chains_webhook      = COALESCE(corp_discord_settings.chains_webhook,      EXCLUDED.chains_webhook),
           updated_at = NOW()`,
    [corpId, url],
  );
}

async function fillAlliance(allianceId: number, url: string): Promise<void> {
  await db.query(
    `INSERT INTO alliance_discord_settings (alliance_id, connections_webhook, chains_webhook, updated_at)
     VALUES ($1, $2, $2, NOW())
     ON CONFLICT (alliance_id) DO UPDATE
       SET connections_webhook = COALESCE(alliance_discord_settings.connections_webhook, EXCLUDED.connections_webhook),
           chains_webhook      = COALESCE(alliance_discord_settings.chains_webhook,      EXCLUDED.chains_webhook),
           updated_at = NOW()`,
    [allianceId, url],
  );
}

export async function seedDiscordWebhooksFromEnv(): Promise<void> {
  const raw = process.env.DISCORD_WEBHOOK_URL;
  if (!raw || !raw.trim()) return;

  const { defaultUrl, byCorp, byAlliance } = parseLegacyEnv(raw);
  let seeded = 0;

  // Specific per-corp / per-alliance overrides.
  for (const [corpId, url] of byCorp) {
    if (isDiscordWebhookUrl(url)) { await fillCorp(corpId, url); seeded++; }
  }
  for (const [allianceId, url] of byAlliance) {
    if (isDiscordWebhookUrl(url)) { await fillAlliance(allianceId, url); seeded++; }
  }

  // The bare default applied to every configured corp AND alliance; seed it for
  // each that lacks a specific override.
  if (defaultUrl && isDiscordWebhookUrl(defaultUrl)) {
    for (const corpId of config.corpIds) {
      if (!byCorp.has(corpId)) { await fillCorp(corpId, defaultUrl); seeded++; }
    }
    for (const allianceId of config.allianceIds) {
      if (!byAlliance.has(allianceId)) { await fillAlliance(allianceId, defaultUrl); seeded++; }
    }
  }

  if (seeded > 0) {
    log.info(`Seeded legacy DISCORD_WEBHOOK_URL into ${seeded} org setting row(s) (fills nulls only). Safe to remove DISCORD_WEBHOOK_URL once verified in the admin UI.`);
  }
}
