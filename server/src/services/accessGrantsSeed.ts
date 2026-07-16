// Seed the login allow-list (access_grants) from the .env CORP_ID / ALLIANCE_ID
// lists on every boot. These env-sourced rows are the deployment's immutable
// "core": the seed reconciles source='env' rows to EXACTLY match the current
// .env lists (inserts new ones, removes any the operator deleted from .env), so
// .env stays the single source of truth for the core while the admin area
// manages everyone else (source != 'env'). Idempotent; runs after migrate().
//
// Mirrors services/discordSeed.ts (env -> DB) but is authoritative rather than
// fill-nulls, because the login gate keys off these rows.
import { db } from '../db.js';
import { config } from '../config.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('accessGrantsSeed');

export async function seedAccessGrantsFromEnv(): Promise<void> {
  // Solo (unrestricted) deployments have no allow-list — nothing to seed and
  // nothing to reconcile away (a solo install never gates login).
  if (!config.restrictedMode) return;

  const wanted: Array<{ kind: 'corp' | 'alliance'; eveId: number }> = [
    ...config.corpIds.map((id) => ({ kind: 'corp' as const, eveId: id })),
    ...config.allianceIds.map((id) => ({ kind: 'alliance' as const, eveId: id })),
  ];

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Upsert every wanted core entry as source='env'. ON CONFLICT re-asserts
    // source='env' so a corp that was once admin-added but is now in .env
    // becomes an (immutable) core row.
    for (const { kind, eveId } of wanted) {
      await client.query(
        `INSERT INTO access_grants (kind, eve_id, source, note)
         VALUES ($1, $2, 'env', 'Seeded from .env')
         ON CONFLICT (kind, eve_id) DO UPDATE SET source = 'env', note = 'Seeded from .env'`,
        [kind, eveId],
      );
    }

    // Remove env rows the operator has since deleted from .env, so editing .env
    // remains the only way to change the core. Never touches admin/share/standing
    // rows. Guarded so an empty `wanted` (shouldn't happen in restricted mode)
    // still deletes correctly via the NOT IN over an empty set.
    const corpIds     = config.corpIds;
    const allianceIds = config.allianceIds;
    await client.query(
      `DELETE FROM access_grants
        WHERE source = 'env'
          AND NOT (
                (kind = 'corp'     AND eve_id = ANY($1::bigint[]))
             OR (kind = 'alliance' AND eve_id = ANY($2::bigint[]))
          )`,
      [corpIds, allianceIds],
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  log.info(`Access allow-list seeded from .env: ${config.corpIds.length} corp, ${config.allianceIds.length} alliance core grant(s).`);
}
