/**
 * One-shot backfill: make existing map systems agree with the SDE.
 *
 * Two problems accumulated while class / effect / statics were accepted from
 * the client and J-codes were stored with no EVE id:
 *
 *   A. Systems that resolve to a real one but disagree with solar_systems —
 *      a C5 pulsar saved as a C1 wolf-rayet, or statics that can't occur.
 *   B. Starter-map systems written with eve_system_id NULL, carrying whatever
 *      statics the old hardcoded seeder had. They're detached placeholders:
 *      no routing, no ESI identity, and invisible to any SDE comparison.
 *
 * Dry run by default — prints what it would change and touches nothing:
 *
 *   cd server && npx tsx scripts/backfill-system-facts.ts
 *   cd server && npx tsx scripts/backfill-system-facts.ts --apply
 *
 * Only names matching ^J[0-9]{6}$ are resolved by name in (B): a J-code is
 * unambiguous, whereas matching arbitrary names risks re-pointing a custom node
 * someone happened to name after a real system. map_systems is unique on
 * (map_id, eve_system_id), so any row whose map already holds that system is
 * skipped rather than crashing the run.
 *
 * Also reports connections whose jump type the SDE contradicts. It does NOT
 * change those: a bad 'gate' might be meant as a wormhole or might be joining
 * the wrong two systems, and only a human knows which.
 */
import 'dotenv/config';
import { db } from '../src/db.js';

const APPLY = process.argv.includes('--apply');

const SORTED = (col: string) =>
  `COALESCE((SELECT array_agg(x ORDER BY x) FROM unnest(${col}) x), '{}')`;

async function main() {
  console.log(APPLY ? 'APPLYING changes\n' : 'DRY RUN — nothing will be written (pass --apply to write)\n');

  // ── A. Resolved systems that disagree with the SDE ────────────────────────
  const { rows: drift } = await db.query<{
    id: string; name: string; map_name: string;
    map_class: string; sde_class: string | null;
    map_effect: string; sde_effect: string;
    map_statics: string[]; sde_statics: string[];
  }>(`
    SELECT ms.id, ms.name, m.name AS map_name,
           ms.system_class AS map_class, ss.class AS sde_class,
           COALESCE(ms.effect,'none') AS map_effect, COALESCE(ss.effect,'none') AS sde_effect,
           ${SORTED('ms.statics')} AS map_statics, ${SORTED('ss.statics')} AS sde_statics
      FROM map_systems ms
      JOIN maps m           ON m.id  = ms.map_id
      JOIN solar_systems ss ON ss.id = ms.eve_system_id
     WHERE ms.eve_system_id IS NOT NULL
       AND (upper(ms.system_class) IS DISTINCT FROM upper(ss.class)
         OR COALESCE(ms.effect,'none') IS DISTINCT FROM COALESCE(ss.effect,'none')
         OR ${SORTED('ms.statics')} IS DISTINCT FROM ${SORTED('ss.statics')})
     ORDER BY m.name, ms.name`);

  console.log(`A. Resolved systems disagreeing with the SDE: ${drift.length}`);
  for (const r of drift) {
    console.log(`   ${r.name} (${r.map_name}): ${r.map_class}/${r.map_effect}/{${r.map_statics}}`
              + `  ->  ${r.sde_class}/${r.sde_effect}/{${r.sde_statics}}`);
  }

  // ── B. Unresolved J-codes that the SDE knows ──────────────────────────────
  const { rows: orphans } = await db.query<{ id: string; name: string; eve_id: number; rn: string }>(`
    WITH cand AS (
      SELECT ms.id, ms.map_id, ms.name, ss.id AS eve_id,
             ROW_NUMBER() OVER (PARTITION BY ms.map_id, ss.id
                                ORDER BY ms.created_at, ms.id) AS rn
        FROM map_systems ms
        JOIN solar_systems ss ON ss.name = ms.name
       WHERE ms.eve_system_id IS NULL
         AND ms.name ~ '^J[0-9]{6}$'
         AND NOT EXISTS (SELECT 1 FROM map_systems x
                          WHERE x.map_id = ms.map_id AND x.eve_system_id = ss.id)
    )
    SELECT id, name, eve_id, rn::text FROM cand WHERE rn = 1`);

  const { rows: [{ blocked }] } = await db.query<{ blocked: string }>(`
    SELECT count(*)::text AS blocked
      FROM map_systems ms
      JOIN solar_systems ss ON ss.name = ms.name
     WHERE ms.eve_system_id IS NULL
       AND ms.name ~ '^J[0-9]{6}$'
       AND EXISTS (SELECT 1 FROM map_systems x
                    WHERE x.map_id = ms.map_id AND x.eve_system_id = ss.id)`);

  const byName = new Map<string, number>();
  for (const o of orphans) byName.set(o.name, (byName.get(o.name) ?? 0) + 1);
  console.log(`\nB. Unresolved J-codes the SDE can identify: ${orphans.length}`
            + ` (${blocked} skipped — that map already holds the system)`);
  for (const [name, n] of [...byName].sort((a, b) => b[1] - a[1])) console.log(`   ${name}: ${n} rows`);

  // ── C. Report only: connections the SDE contradicts ───────────────────────
  const { rows: badConns } = await db.query<{ map_name: string; kind: string; source: string; target: string }>(`
    SELECT m.name AS map_name, c.connection_type AS kind, s.name AS source, t.name AS target
      FROM map_connections c
      JOIN maps m        ON m.id = c.map_id
      JOIN map_systems s ON s.id = c.source_id
      JOIN map_systems t ON t.id = c.target_id
     WHERE s.eve_system_id IS NOT NULL AND t.eve_system_id IS NOT NULL
       AND (
         (c.connection_type = 'gate' AND NOT EXISTS (
            SELECT 1 FROM map_stargates g
             WHERE (g.system_id = s.eve_system_id AND g.destination_system_id = t.eve_system_id)
                OR (g.system_id = t.eve_system_id AND g.destination_system_id = s.eve_system_id)))
      OR (c.connection_type IN ('jumpgate','cyno') AND (
            NOT EXISTS (SELECT 1 FROM map_stargates g WHERE g.system_id = s.eve_system_id)
         OR NOT EXISTS (SELECT 1 FROM map_stargates g WHERE g.system_id = t.eve_system_id)))
       )
     ORDER BY m.name`);
  console.log(`\nC. Connections the SDE contradicts (reported only, not changed): ${badConns.length}`);
  for (const c of badConns) console.log(`   ${c.map_name}: ${c.source} <-> ${c.target} as '${c.kind}'`);

  if (!APPLY) {
    console.log('\nDry run complete — nothing written.');
    await db.end();
    return;
  }

  if (drift.length > 0) {
    await db.query(
      `UPDATE map_systems ms
          SET system_class = ss.class,
              effect       = COALESCE(ss.effect, 'none'),
              statics      = COALESCE(ss.statics, '{}')
         FROM solar_systems ss
        WHERE ss.id = ms.eve_system_id AND ms.id = ANY($1::uuid[])`,
      [drift.map((r) => r.id)],
    );
    console.log(`\nRe-synced ${drift.length} system(s) to the SDE.`);
  }

  if (orphans.length > 0) {
    const BATCH = 500;
    let done = 0;
    for (let i = 0; i < orphans.length; i += BATCH) {
      const batch = orphans.slice(i, i + BATCH);
      await db.query(
        `UPDATE map_systems ms
            SET eve_system_id = ss.id,
                system_class  = ss.class,
                effect        = COALESCE(ss.effect, 'none'),
                statics       = COALESCE(ss.statics, '{}')
           FROM solar_systems ss
          WHERE ms.id = ANY($1::uuid[]) AND ss.name = ms.name`,
        [batch.map((r) => r.id)],
      );
      done += batch.length;
      process.stdout.write(`\r  resolved ${done} / ${orphans.length}`);
    }
    console.log(`\nResolved ${done} J-code placeholder(s) to their real system.`);
  }

  await db.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
