import { db } from '../db.js';
import { config } from '../config.js';
import { getValidToken } from '../utils/eveToken.js';
import { createLogger } from '../utils/logger.js';
import { notifyDiscord, fuelAlertEmbed } from './discord.js';

const log = createLogger('corp-structures');
const POLL_MS = 61 * 60 * 1000;

const lastWorkingUser = new Map<number, number>();

export async function initCorpStructures(): Promise<void> {
  if (!config.corpMode) return;

  try { await pollAllCorps(); }
  catch (err) { log.error('boot poll failed:', err); }

  setInterval(() => {
    pollAllCorps().catch((err) => log.error('poll failed:', err));
  }, POLL_MS);
}

async function pollAllCorps(): Promise<void> {
  for (const corpId of config.corpIds) {
    try {
      await pollCorp(corpId);
    } catch (err) {
      log.error(`corp ${corpId} poll failed:`, err);
    }
  }
}

async function pollCorp(corpId: number): Promise<void> {
  const token = await findWorkingToken(corpId);
  if (!token) {
    log.info(`corp ${corpId}: no working Station_Manager token — skipping`);
    return;
  }

  const structures = await fetchAllPages(corpId, token);
  if (structures === null) return;

  await upsertStructures(structures);
  await markRemoved(corpId, structures.map((s) => s.structure_id));
  await checkFuelAlerts(corpId);

  log.info(`corp ${corpId}: polled ${structures.length} structure(s)`);
}

interface ESIStructure {
  structure_id: number;
  corporation_id: number;
  system_id: number;
  type_id: number;
  name?: string;
  state: string;
  fuel_expires?: string;
  services?: { name: string; state: string }[];
  reinforce_hour?: number;
  state_timer_start?: string;
  state_timer_end?: string;
  unanchors_at?: string;
}

async function findWorkingToken(corpId: number): Promise<string | null> {
  const cached = lastWorkingUser.get(corpId);
  if (cached) {
    const token = await tryUserToken(cached, corpId);
    if (token) return token;
    lastWorkingUser.delete(corpId);
  }

  const { rows } = await db.query<{ id: number }>(
    `SELECT id FROM users WHERE corp_id = $1 AND has_structures_scope = TRUE AND role != 'blocked'`,
    [corpId],
  );

  for (const row of rows) {
    const token = await tryUserToken(row.id, corpId);
    if (token) {
      lastWorkingUser.set(corpId, row.id);
      return token;
    }
  }

  return null;
}

async function tryUserToken(userId: number, corpId: number): Promise<string | null> {
  try {
    const token = await getValidToken(userId);
    const res = await fetch(
      `https://esi.evetech.net/v4/corporations/${corpId}/structures/?datasource=tranquility&page=1`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (res.ok) return token;
    if (res.status === 403) {
      await db.query(`UPDATE users SET has_station_manager = FALSE WHERE id = $1`, [userId]);
      log.info(`user ${userId}: lost Station_Manager — marked`);
    }
    return null;
  } catch {
    return null;
  }
}

async function fetchAllPages(corpId: number, token: string): Promise<ESIStructure[] | null> {
  const firstRes = await fetch(
    `https://esi.evetech.net/v4/corporations/${corpId}/structures/?datasource=tranquility&page=1`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!firstRes.ok) {
    log.warn(`corp ${corpId}: ESI returned ${firstRes.status}`);
    return null;
  }

  const structures: ESIStructure[] = await firstRes.json() as ESIStructure[];
  const totalPages = parseInt(firstRes.headers.get('x-pages') ?? '1', 10);

  if (totalPages > 1) {
    const pagePromises = [];
    for (let page = 2; page <= totalPages; page++) {
      pagePromises.push(
        fetch(
          `https://esi.evetech.net/v4/corporations/${corpId}/structures/?datasource=tranquility&page=${page}`,
          { headers: { Authorization: `Bearer ${token}` } },
        ).then((r) => r.ok ? r.json() as Promise<ESIStructure[]> : []),
      );
    }
    const pages = await Promise.all(pagePromises);
    for (const page of pages) structures.push(...page);
  }

  return structures;
}

async function upsertStructures(structures: ESIStructure[]): Promise<void> {
  for (const s of structures) {
    await db.query(
      `INSERT INTO corp_structures
         (structure_id, corporation_id, system_id, type_id, name, state,
          fuel_expires, services, reinforce_hour,
          state_timer_start, state_timer_end, unanchors_at, last_polled, removed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW(),NULL)
       ON CONFLICT (structure_id) DO UPDATE SET
         corporation_id    = EXCLUDED.corporation_id,
         system_id         = EXCLUDED.system_id,
         type_id           = EXCLUDED.type_id,
         name              = EXCLUDED.name,
         state             = EXCLUDED.state,
         fuel_expires      = EXCLUDED.fuel_expires,
         services          = EXCLUDED.services,
         reinforce_hour    = EXCLUDED.reinforce_hour,
         state_timer_start = EXCLUDED.state_timer_start,
         state_timer_end   = EXCLUDED.state_timer_end,
         unanchors_at      = EXCLUDED.unanchors_at,
         last_polled       = NOW(),
         removed_at        = NULL`,
      [s.structure_id, s.corporation_id, s.system_id, s.type_id,
       s.name ?? '', s.state,
       s.fuel_expires ?? null, JSON.stringify(s.services ?? []),
       s.reinforce_hour ?? null,
       s.state_timer_start ?? null, s.state_timer_end ?? null,
       s.unanchors_at ?? null],
    );
  }
}

async function markRemoved(corpId: number, activeIds: number[]): Promise<void> {
  if (activeIds.length === 0) {
    await db.query(
      `UPDATE corp_structures SET removed_at = NOW() WHERE corporation_id = $1 AND removed_at IS NULL`,
      [corpId],
    );
    return;
  }
  await db.query(
    `UPDATE corp_structures SET removed_at = NOW()
     WHERE corporation_id = $1 AND removed_at IS NULL
       AND structure_id != ALL($2)`,
    [corpId, activeIds],
  );
}

async function checkFuelAlerts(corpId: number): Promise<void> {
  const { rows } = await db.query<{
    structure_id: number; name: string; system_id: number;
    fuel_expires: string; type_id: number;
  }>(
    `SELECT cs.structure_id, cs.name, cs.system_id, cs.fuel_expires, cs.type_id
     FROM corp_structures cs
     WHERE cs.corporation_id = $1
       AND cs.fuel_expires IS NOT NULL
       AND cs.fuel_expires <= NOW() + make_interval(hours => $2)
       AND cs.removed_at IS NULL
       AND (cs.fuel_alert_sent_at IS NULL
            OR cs.fuel_alert_sent_at < cs.fuel_expires - make_interval(hours => $2))`,
    [corpId, config.fuelAlertHours],
  );

  for (const row of rows) {
    const hoursLeft = Math.max(0, Math.round(
      (new Date(row.fuel_expires).getTime() - Date.now()) / (1000 * 60 * 60),
    ));

    const systemName = await resolveSystemName(row.system_id);

    notifyDiscord(corpId, fuelAlertEmbed({
      structureName: row.name,
      systemName,
      hoursLeft,
    }));

    await db.query(
      `UPDATE corp_structures SET fuel_alert_sent_at = NOW() WHERE structure_id = $1`,
      [row.structure_id],
    );
  }
}

async function resolveSystemName(eveSystemId: number): Promise<string> {
  const { rows } = await db.query<{ name: string }>(
    `SELECT name FROM solar_systems WHERE eve_system_id = $1`,
    [eveSystemId],
  );
  return rows[0]?.name ?? `System ${eveSystemId}`;
}
