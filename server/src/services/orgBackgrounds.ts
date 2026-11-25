import type { Request } from 'express';
import { db } from '../db.js';
import { config } from '../config.js';
import { resolveWriteScope, type OrgScope } from './flagPresets.js';

// Map background pictures an admin offers their org: up to MAX_BACKGROUNDS per
// corp or alliance, one of them the default. Members see the default unless
// they pick another or none (a pilot setting), and a pilot's own picture on
// their device overrides both (web/src/utils/mapBackground.ts).
//
// Corp and alliance installs only: a solo install, like the public site, has
// no org to offer them to, and every function here answers "nothing" there.
//
// Scoped like the connection-flag presets: an alliance admin on an alliance
// install manages the alliance's, any other admin their corp's. Members read
// the alliance's when it has any, else their corp's.

export const MAX_BACKGROUNDS = 5;
/** Decoded bytes, after the admin's browser scaled it down. Keeps the upload
 *  under nginx's default 1 MB request cap once base64'd into JSON. */
export const MAX_BACKGROUND_BYTES = 700 * 1024;
export const MAX_BACKGROUND_NAME = 40;

export interface OrgBackground {
  id: string;
  name: string;
  isDefault: boolean;
}

/** The picture type from its first bytes; anything else is refused. The
 *  client's claimed type is never trusted. */
export function sniffImage(buf: Buffer): 'image/webp' | 'image/jpeg' | 'image/png' | null {
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  return null;
}

/** The org an admin manages backgrounds for; null on a solo install. */
export function backgroundWriteScope(req: Request): OrgScope | null {
  return config.restrictedMode ? resolveWriteScope(req) : null;
}

async function hasAny(scope: OrgScope): Promise<boolean> {
  const { rowCount } = await db.query(
    `SELECT 1 FROM org_backgrounds WHERE scope_kind = $1 AND scope_id = $2 LIMIT 1`, [scope.kind, scope.id]);
  return !!rowCount;
}

/** The org whose backgrounds a member sees; null on a solo install. */
export async function backgroundReadScope(req: Request): Promise<OrgScope | null> {
  if (!config.restrictedMode) return null;
  const allianceId = req.session.userAllianceId ?? null;
  const corpId = req.session.userCorpId ?? null;
  if (config.allianceMode && allianceId != null) {
    const alliance: OrgScope = { kind: 'alliance', id: allianceId };
    if (corpId == null || (await hasAny(alliance))) return alliance;
  }
  return corpId != null ? { kind: 'corp', id: corpId } : null;
}

export async function listBackgrounds(scope: OrgScope): Promise<OrgBackground[]> {
  const { rows } = await db.query<OrgBackground>(
    `SELECT id, name, is_default AS "isDefault" FROM org_backgrounds
      WHERE scope_kind = $1 AND scope_id = $2 ORDER BY created_at, id`, [scope.kind, scope.id]);
  return rows;
}

export class BackgroundLimit extends Error {}

/** Add one; the org's first becomes its default. */
export async function addBackground(
  scope: OrgScope, data: Buffer, mime: string, name: string, userId: number | null,
): Promise<OrgBackground> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // One upload at a time per org, so two admins can't both add a fifth.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('org_backgrounds:' || $1 || ':' || $2))`, [scope.kind, scope.id]);
    const { rows: [{ n }] } = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM org_backgrounds WHERE scope_kind = $1 AND scope_id = $2`, [scope.kind, scope.id]);
    if (n >= MAX_BACKGROUNDS) throw new BackgroundLimit();
    const { rows: [row] } = await client.query<OrgBackground>(
      `INSERT INTO org_backgrounds (scope_kind, scope_id, name, mime, data, is_default, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, name, is_default AS "isDefault"`,
      [scope.kind, scope.id, name, mime, data, n === 0, userId]);
    await client.query('COMMIT');
    return row;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** True if it was there. Deleting the default leaves the org without one. */
export async function removeBackground(scope: OrgScope, id: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `DELETE FROM org_backgrounds WHERE id = $1 AND scope_kind = $2 AND scope_id = $3`, [id, scope.kind, scope.id]);
  return !!rowCount;
}

/** Make `id` the default, or clear the default with null. False if `id`
 *  isn't one of this org's. */
export async function setDefaultBackground(scope: OrgScope, id: string | null): Promise<boolean> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE org_backgrounds SET is_default = FALSE WHERE scope_kind = $1 AND scope_id = $2 AND is_default`,
      [scope.kind, scope.id]);
    if (id) {
      const { rowCount } = await client.query(
        `UPDATE org_backgrounds SET is_default = TRUE WHERE id = $1 AND scope_kind = $2 AND scope_id = $3`,
        [id, scope.kind, scope.id]);
      if (!rowCount) { await client.query('ROLLBACK'); return false; }
    }
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function renameBackground(scope: OrgScope, id: string, name: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE org_backgrounds SET name = $4 WHERE id = $1 AND scope_kind = $2 AND scope_id = $3`,
    [id, scope.kind, scope.id, name]);
  return !!rowCount;
}

/** The picture itself, only if it belongs to `scope`. */
export async function readBackgroundImage(scope: OrgScope, id: string): Promise<{ mime: string; data: Buffer } | null> {
  const { rows } = await db.query<{ mime: string; data: Buffer }>(
    `SELECT mime, data FROM org_backgrounds WHERE id = $1 AND scope_kind = $2 AND scope_id = $3`,
    [id, scope.kind, scope.id]);
  return rows[0] ?? null;
}
