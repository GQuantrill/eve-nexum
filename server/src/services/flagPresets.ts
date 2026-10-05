import type { Request } from 'express';
import { db } from '../db.js';
import { config } from '../config.js';
import { isAllianceAdmin } from '../middleware/authContext.js';

// Connection-flag presets: saved {icon, colour, name} templates so a corp can
// standardise its signals instead of every pilot inventing their own.

export interface FlagPreset { id: string; name: string; icon: string; color: string }

export const MAX_FLAG_PRESETS = 12;

// These mirror the bounds the connection PATCH enforces on the fields a preset
// writes (server/src/routes/maps.ts). Without them an admin could save a preset
// that looks fine in the editor and is rejected every time anyone applies it.
const ICON_MAX  = 64;
const NAME_MAX  = 200;
const COLOR_RE  = /^#[0-9a-fA-F]{6}$/;
const ID_RE     = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Validate and normalise a whole preset list from a request body.
 * Returns null when the input is unusable, so the caller can 400 rather than
 * silently storing a truncated list — an admin who typed a bad colour should be
 * told, not left wondering why one preset vanished.
 */
export function parsePresets(raw: unknown): FlagPreset[] | null {
  if (!Array.isArray(raw)) return null;
  if (raw.length > MAX_FLAG_PRESETS) return null;
  const out: FlagPreset[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (item == null || typeof item !== 'object') return null;
    const p = item as Record<string, unknown>;
    const id    = typeof p.id === 'string' ? p.id : '';
    const name  = typeof p.name === 'string' ? p.name.trim() : '';
    const icon  = typeof p.icon === 'string' ? p.icon.trim() : '';
    const color = typeof p.color === 'string' ? p.color.trim() : '';
    if (!ID_RE.test(id) || seen.has(id)) return null;
    if (!name || name.length > NAME_MAX) return null;
    if (!icon || icon.length > ICON_MAX) return null;
    if (!COLOR_RE.test(color)) return null;
    seen.add(id);
    out.push({ id, name, icon, color });
  }
  return out;
}

export type OrgScope = { kind: 'corp' | 'alliance'; id: number };

/**
 * Which org's presets this caller may EDIT. Alliance takes precedence in an
 * alliance-mode deployment when the caller is an alliance admin; otherwise
 * their corp. null when they have no org (a personal deployment).
 *
 * Deliberately the same rule the Discord settings use — an admin manages one
 * org, and which one is derived from the session, never from the body.
 */
export function resolveWriteScope(req: Request): OrgScope | null {
  const role       = req.session.role ?? 'readonly';
  const allianceId = req.session.userAllianceId ?? null;
  const corpId     = req.session.userCorpId ?? null;
  if (config.allianceMode && allianceId != null && isAllianceAdmin(role)) return { kind: 'alliance', id: allianceId };
  if (corpId != null) return { kind: 'corp', id: corpId };
  return null;
}

/**
 * Which presets APPLY to this caller — a different question from which they may
 * edit, and the difference matters.
 *
 * A plain member of an alliance is not an alliance admin, so the write rule
 * above would point them at their corp and they would never see what their
 * alliance admin set. Read therefore prefers the alliance row whenever the
 * deployment is in alliance mode, and falls back to the corp row when the
 * alliance has none — which also keeps corp-level presets working in an
 * alliance deployment that never set any.
 */
export async function readPresetsFor(req: Request): Promise<FlagPreset[]> {
  const allianceId = req.session.userAllianceId ?? null;
  const corpId     = req.session.userCorpId ?? null;

  if (config.allianceMode && allianceId != null) {
    const { rows } = await db.query<{ presets: FlagPreset[] }>(
      `SELECT presets FROM alliance_flag_presets WHERE alliance_id = $1`, [allianceId]);
    const list = rows[0]?.presets;
    if (Array.isArray(list) && list.length > 0) return list;
  }
  if (corpId != null) {
    const { rows } = await db.query<{ presets: FlagPreset[] }>(
      `SELECT presets FROM corp_flag_presets WHERE corp_id = $1`, [corpId]);
    return rows[0]?.presets ?? [];
  }
  return [];
}

/** The stored list for one scope, for the admin editor to load. */
export async function readScopePresets(scope: OrgScope): Promise<FlagPreset[]> {
  // Literal SQL per branch (no interpolated identifiers), matching the Discord
  // settings: the table and scope column are never string-built from a variable.
  const { rows } = scope.kind === 'alliance'
    ? await db.query<{ presets: FlagPreset[] }>(
        `SELECT presets FROM alliance_flag_presets WHERE alliance_id = $1`, [scope.id])
    : await db.query<{ presets: FlagPreset[] }>(
        `SELECT presets FROM corp_flag_presets WHERE corp_id = $1`, [scope.id]);
  return rows[0]?.presets ?? [];
}

export async function writeScopePresets(scope: OrgScope, presets: FlagPreset[]): Promise<void> {
  const json = JSON.stringify(presets);
  if (scope.kind === 'alliance') {
    await db.query(
      `INSERT INTO alliance_flag_presets (alliance_id, presets, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (alliance_id) DO UPDATE SET presets = EXCLUDED.presets, updated_at = NOW()`,
      [scope.id, json],
    );
  } else {
    await db.query(
      `INSERT INTO corp_flag_presets (corp_id, presets, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (corp_id) DO UPDATE SET presets = EXCLUDED.presets, updated_at = NOW()`,
      [scope.id, json],
    );
  }
}
