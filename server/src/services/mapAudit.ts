import type { Request } from 'express';
import { db } from '../db.js';
import { authUser } from '../middleware/authContext.js';
import { createLogger } from '../utils/logger.js';

// Per-map audit log: who added, removed or changed what on a map. Structural
// changes only — dragging nodes around and the server's own sweeps (expiry,
// auto-cleanup) aren't recorded. Readable by the map's owner and by the
// corp/alliance admins of an org map (see routes/maps.ts).

const log = createLogger('mapAudit');

export const MAP_AUDIT_RETENTION_DAYS = 30;

// Repeat edits to the same thing by the same person within this window of the
// first update one entry instead of adding another: a signature saves on every keystroke,
// and "changed the name" forty times over says less than once.
const COALESCE_WINDOW = '2 minutes';

/** Who made a change, as recorded against it. */
export interface AuditActor {
  userId:        number | null;
  characterId:   number | null;
  characterName: string | null;
  viaApi:        boolean;
}

export function auditActor(req: Request): AuditActor {
  const who = authUser(req);
  return {
    userId:        who.userId ?? null,
    characterId:   who.characterId ?? null,
    characterName: who.characterName ?? null,
    viaApi:        !!req.apiAuth,
  };
}

export interface AuditEntry {
  /** e.g. 'system.add', 'connection.update', 'signature.remove'. */
  action:    string;
  /** The thing acted on, written out the way the map shows it ("J123456 (Home)"). */
  subject?:  string | null;
  /** Its row id, so repeat edits to it can be folded together. */
  targetId?: string | null;
  /** Action-specific extras; `fields` lists what an update changed. */
  details?:  { fields?: string[]; values?: Record<string, unknown>; [k: string]: unknown } | null;
}

/**
 * Record one change. Fire-and-forget: a failed audit write is logged, never
 * allowed to fail the change it describes.
 */
export function recordMapAudit(who: Request | AuditActor, mapId: string, entry: AuditEntry): void {
  void writeMapAudit('viaApi' in who ? who : auditActor(who), mapId, entry)
    .catch((err) => log.warn(`audit write failed (${entry.action}):`, err));
}

/** The awaitable form of recordMapAudit, for tests and callers that need ordering. */
export async function writeMapAudit(who: AuditActor, mapId: string, entry: AuditEntry): Promise<void> {
  const details = entry.details ? JSON.stringify(entry.details) : null;
  const targetId = entry.targetId ?? null;
  // An update folds into this person's last update of the same thing if that
  // began within the window: the field lists are merged and the latest values
  // and subject win. The entry keeps its first time (the log is ordered by id),
  // so a long session of edits still breaks into an entry every few minutes.
  // Anything else is a new row.
  if (entry.action.endsWith('.update') && targetId && who.userId != null) {
    const { rowCount } = await db.query(
      `UPDATE map_audit a
          SET subject    = COALESCE($5, a.subject),
              details    = COALESCE(a.details, '{}'::jsonb) || COALESCE($6::jsonb, '{}'::jsonb)
                           || jsonb_build_object(
                                'fields', (SELECT COALESCE(jsonb_agg(DISTINCT f), '[]'::jsonb)
                                             FROM jsonb_array_elements_text(
                                                    COALESCE(a.details->'fields', '[]'::jsonb)
                                                    || COALESCE($6::jsonb->'fields', '[]'::jsonb)) f),
                                'values', COALESCE(a.details->'values', '{}'::jsonb) || COALESCE($6::jsonb->'values', '{}'::jsonb))
        WHERE a.id = (
          SELECT id FROM map_audit
           WHERE map_id = $1 AND user_id = $2 AND action = $3 AND target_id = $4
             AND created_at > NOW() - INTERVAL '${COALESCE_WINDOW}'
           ORDER BY created_at DESC LIMIT 1)`,
      [mapId, who.userId, entry.action, targetId, entry.subject ?? null, details],
    );
    if ((rowCount ?? 0) > 0) return;
  }
  await db.query(
    `INSERT INTO map_audit (map_id, user_id, character_id, character_name, via_api, action, target_id, subject, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [mapId, who.userId, who.characterId, who.characterName, who.viaApi,
     entry.action, targetId, entry.subject ?? null, details],
  );
}

/** How a system reads in the log: its alias with the real name, or just the name. */
export function systemLabel(row: { name: string | null; alias?: string | null } | undefined): string | null {
  if (!row) return null;
  const name = row.name ?? '?';
  return row.alias ? `${row.alias} (${name})` : name;
}

/** Labels for systems on a map, by id — for describing connections. */
export async function systemLabels(mapId: string, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const { rows } = await db.query<{ id: string; name: string | null; alias: string | null }>(
    `SELECT id, name, alias FROM map_systems WHERE map_id = $1 AND id = ANY($2::uuid[])`,
    [mapId, ids],
  );
  for (const r of rows) out.set(r.id, systemLabel(r) ?? '?');
  return out;
}

/** "A ↔ B" for a connection between two systems on the map. */
export async function connectionLabel(mapId: string, sourceId: string, targetId: string): Promise<string> {
  const labels = await systemLabels(mapId, [sourceId, targetId]);
  return `${labels.get(sourceId) ?? '?'} ↔ ${labels.get(targetId) ?? '?'}`;
}

/** Something in a system — a signature, anomaly or structure: "ABC-123 in J123456". */
export async function inSystemLabel(mapId: string, systemId: string, item: string): Promise<string> {
  const labels = await systemLabels(mapId, [systemId]);
  return `${item || '?'} in ${labels.get(systemId) ?? '?'}`;
}

/** A saved chain: its name, or "A → B" when it hasn't been given one. */
export async function chainLabel(mapId: string, name: string | null, systemIds: string[]): Promise<string> {
  if (name && name.trim()) return name.trim();
  const first = systemIds[0];
  const last  = systemIds[systemIds.length - 1];
  if (!first || !last) return '?';
  const labels = await systemLabels(mapId, [first, last]);
  return `${labels.get(first) ?? '?'} → ${labels.get(last) ?? '?'}`;
}

/** Drop entries past the retention window. */
export async function pruneMapAudit(): Promise<number> {
  const { rowCount } = await db.query(
    `DELETE FROM map_audit WHERE created_at < NOW() - make_interval(days => $1)`,
    [MAP_AUDIT_RETENTION_DAYS],
  );
  return rowCount ?? 0;
}

export function startMapAuditPruner(): void {
  const run = () => {
    pruneMapAudit()
      .then((n) => { if (n > 0) log.info(`pruned ${n} audit entr${n === 1 ? 'y' : 'ies'}`); })
      .catch((err) => log.warn('audit prune failed:', err));
  };
  run();
  setInterval(run, 6 * 60 * 60 * 1000).unref();
}
