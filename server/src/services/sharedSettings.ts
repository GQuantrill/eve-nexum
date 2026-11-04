import { db } from '../db.js';

// Settings shared across an account's linked characters (opt-in per account,
// owners.share_settings). Sharing is done by writing every change to every
// linked character's row, so each row stays a complete copy and nothing that
// reads a character's settings needs to know about sharing.

// Kept per character even when sharing: jump skills differ from pilot to
// pilot, and one pilot's levels would give another wrong range and fuel.
const PER_CHARACTER_KEYS = new Set(['nexum.jump.jdc', 'nexum.jump.jf', 'nexum.jump.jfc']);

export function shareableEntries(entries: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(entries).filter(([k]) => !PER_CHARACTER_KEYS.has(k)));
}

/** The OTHER characters a settings change from `userId` should be copied to:
 *  the account's linked characters when it shares settings, else none. */
export async function settingsSiblings(userId: number): Promise<number[]> {
  const { rows } = await db.query<{ id: number }>(
    `SELECT u2.id
       FROM users u
       JOIN owners o ON o.id = u.owner_id AND o.share_settings
       JOIN users u2 ON u2.owner_id = u.owner_id AND u2.id <> u.id
      WHERE u.id = $1`,
    [userId],
  );
  return rows.map((r) => r.id);
}

// The preference columns, all shared.
const PREF_COLUMNS = [
  'compact_mode', 'snap_to_grid', 'show_minimap', 'uniform_size', 'show_statics',
  'easy_connect', 'connection_thickness', 'route_mode', 'ui_zoom', 'panel_order',
] as const;

interface SettingsRow { id: number; ui_settings: Record<string, unknown> }

/** Fold the characters' settings into one shared set: oldest change first, so
 *  for each key the most recently changed character wins, and a key only one
 *  character has is kept. Pure; exported for the tests. */
export function mergeSettings(rowsOldestFirst: SettingsRow[]): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const r of rowsOldestFirst) Object.assign(merged, shareableEntries(r.ui_settings ?? {}));
  return merged;
}

/** Turn sharing on or off for an account. Turning it on starts every linked
 *  character from the merged settings, and their preference columns from the
 *  most recently changed character. Returns the account's character ids. */
export async function setShareSettings(ownerId: number, enabled: boolean): Promise<number[]> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(`UPDATE owners SET share_settings = $1 WHERE id = $2`, [enabled, ownerId]);
    const { rows } = await client.query<SettingsRow>(
      `SELECT id, ui_settings FROM users WHERE owner_id = $1
        ORDER BY COALESCE(settings_updated_at, last_login_at, updated_at) ASC NULLS FIRST, id`,
      [ownerId],
    );
    if (enabled && rows.length > 1) {
      const merged = mergeSettings(rows);
      const latest = rows[rows.length - 1].id;
      const cols = PREF_COLUMNS.map((c) => `${c} = src.${c}`).join(', ');
      await client.query(
        `UPDATE users u
            SET ui_settings = u.ui_settings || $1::jsonb, ${cols}
           FROM users src
          WHERE src.id = $2 AND u.owner_id = $3`,
        [JSON.stringify(merged), latest, ownerId],
      );
    }
    await client.query('COMMIT');
    return rows.map((r) => r.id);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
