import type { Request } from 'express';
import { db } from '../db.js';
import { config } from '../config.js';
import { settingAllowed } from '../routes/auth.js';
import type { OrgScope } from './flagPresets.js';

// The org's starting UI configuration: an admin arranges their own layout,
// captures it, and members inherit anything they have never set themselves.

/** The ten pref columns on `users`, as the client names them. */
export interface OrgPrefs {
  compactMode?:         boolean;
  snapToGrid?:          boolean;
  showMinimap?:         boolean;
  uniformSize?:         boolean;
  showStatics?:         boolean;
  easyConnect?:         boolean;
  connectionThickness?: string;
  routeMode?:           string;
  uiZoom?:              number;
  panelOrder?:          string[];
}

export interface OrgUiDefaults {
  settings: Record<string, unknown>;
  prefs:    OrgPrefs;
  updatedAt:   string | null;
  updatedByName: string | null;
}

export const EMPTY_DEFAULTS: OrgUiDefaults = { settings: {}, prefs: {}, updatedAt: null, updatedByName: null };

/**
 * Settings that must NEVER become an org default, even though they sync fine as
 * personal settings. Captured by prefix so a new key in one of these families
 * is excluded by default rather than by somebody remembering.
 *
 *   jump skills   drive the jump planner's range and fuel maths. One person's
 *                 skills presented as everyone's would quietly give the rest of
 *                 the org wrong numbers -- worse than no default at all.
 *   presence      a privacy choice. Nobody else gets to make it.
 *   watchlist     one pilot's list of people to watch.
 *   account       bound to a specific account's characters.
 */
const NEVER_CAPTURE_PREFIXES = [
  'nexum.jump.',
  'nexum.presence.',
  'nexum.watchlist',
  'nexum.account.',
];

export function capturable(key: string): boolean {
  if (!settingAllowed(key)) return false;             // never synced; nothing to capture
  return !NEVER_CAPTURE_PREFIXES.some((p) => key.startsWith(p));
}

/**
 * Which org's defaults apply to a member with this corp/alliance. Mirrors
 * resolveScoutScope: a member is not an admin, so this carries no role check --
 * unlike the admin WRITE scope, where being an alliance admin is what decides
 * whether you manage the alliance or just your corp.
 *
 * Takes the ids rather than the request because the login callback needs it
 * before the session has been populated.
 */
export function orgScopeFor(corpId: number | null, allianceId: number | null): OrgScope | null {
  if (config.allianceMode && allianceId != null) return { kind: 'alliance', id: allianceId };
  if (config.corpMode && corpId != null) return { kind: 'corp', id: corpId };
  return null;
}

export function resolveReadScope(req: Request): OrgScope | null {
  return orgScopeFor(req.session.userCorpId ?? null, req.session.userAllianceId ?? null);
}

interface Row {
  settings: Record<string, unknown>;
  prefs: OrgPrefs;
  updatedAt: string | null;
  updatedByName: string | null;
}

export async function readDefaults(scope: OrgScope | null): Promise<OrgUiDefaults> {
  if (!scope) return EMPTY_DEFAULTS;
  const { rows } = await db.query<Row>(
    `SELECT d.settings, d.prefs, d.updated_at AS "updatedAt", u.character_name AS "updatedByName"
       FROM org_ui_defaults d
       LEFT JOIN users u ON u.id = d.updated_by
      WHERE d.scope_kind = $1 AND d.scope_id = $2`,
    [scope.kind, scope.id],
  );
  const r = rows[0];
  if (!r) return EMPTY_DEFAULTS;
  return {
    settings: r.settings ?? {},
    prefs: r.prefs ?? {},
    updatedAt: r.updatedAt,
    updatedByName: r.updatedByName,
  };
}

/**
 * Capture the caller's own configuration as the org default.
 *
 * Reads from the database rather than taking a payload: the client has nothing
 * to send that the server cannot read for itself, and doing it this way means
 * the allowlist and the never-capture rules are enforced by construction rather
 * than by validating whatever arrived.
 */
export async function captureFrom(userId: number, scope: OrgScope): Promise<OrgUiDefaults> {
  const { rows } = await db.query<{
    ui_settings: Record<string, unknown>;
    compact_mode: boolean; snap_to_grid: boolean; show_minimap: boolean;
    uniform_size: boolean; show_statics: boolean; easy_connect: boolean;
    connection_thickness: string; route_mode: string; ui_zoom: string; panel_order: string[];
  }>(
    `SELECT ui_settings, compact_mode, snap_to_grid, show_minimap, uniform_size, show_statics,
            easy_connect, connection_thickness, route_mode, ui_zoom, panel_order
       FROM users WHERE id = $1`,
    [userId],
  );
  const u = rows[0];
  if (!u) throw new Error('capturing user not found');

  const settings: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(u.ui_settings ?? {})) {
    if (capturable(k)) settings[k] = v;
  }
  const prefs: OrgPrefs = {
    compactMode: u.compact_mode,
    snapToGrid:  u.snap_to_grid,
    showMinimap: u.show_minimap,
    uniformSize: u.uniform_size,
    showStatics: u.show_statics,
    easyConnect: u.easy_connect,
    connectionThickness: u.connection_thickness,
    routeMode:   u.route_mode,
    // NUMERIC comes back as a string from pg.
    uiZoom:      Number(u.ui_zoom),
    panelOrder:  u.panel_order,
  };

  await db.query(
    `INSERT INTO org_ui_defaults (scope_kind, scope_id, settings, prefs, updated_by, updated_at)
     VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, NOW())
     ON CONFLICT (scope_kind, scope_id) DO UPDATE
       SET settings = EXCLUDED.settings, prefs = EXCLUDED.prefs,
           updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
    [scope.kind, scope.id, JSON.stringify(settings), JSON.stringify(prefs), userId],
  );
  return readDefaults(scope);
}

export async function clearDefaults(scope: OrgScope): Promise<void> {
  await db.query(`DELETE FROM org_ui_defaults WHERE scope_kind = $1 AND scope_id = $2`,
    [scope.kind, scope.id]);
}

/**
 * Apply the org's column-backed prefs to a NEWLY CREATED account.
 *
 * Only at creation, and this is the honest limit of the feature: those ten
 * columns are NOT NULL with schema defaults, so a member who has never touched
 * `compact_mode` is indistinguishable from one who set it to false on purpose.
 * Filling them in later would be guesswork at the expense of someone's actual
 * choice. The ui_settings half has no such problem -- an absent key really is
 * absent -- so it is inherited live, for everyone.
 */
export async function applyPrefsToNewUser(userId: number, scope: OrgScope | null): Promise<void> {
  if (!scope) return;
  const { prefs } = await readDefaults(scope);
  const cols: Array<[string, unknown]> = [];
  const push = (col: string, v: unknown) => { if (v !== undefined && v !== null) cols.push([col, v]); };
  push('compact_mode', prefs.compactMode);
  push('snap_to_grid', prefs.snapToGrid);
  push('show_minimap', prefs.showMinimap);
  push('uniform_size', prefs.uniformSize);
  push('show_statics', prefs.showStatics);
  push('easy_connect', prefs.easyConnect);
  push('connection_thickness', prefs.connectionThickness);
  push('route_mode', prefs.routeMode);
  push('ui_zoom', prefs.uiZoom);
  push('panel_order', prefs.panelOrder);
  if (cols.length === 0) return;

  // Column names come from the literals above, never from the stored JSON.
  const sets = cols.map(([c], i) => `${c} = $${i + 2}`).join(', ');
  await db.query(`UPDATE users SET ${sets} WHERE id = $1`, [userId, ...cols.map(([, v]) => v)]);
}
