import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';

import { ensureIntegrationDb, truncateAll, seedUser } from '../test/integrationDb.js';
import { db } from '../db.js';
import { migrate } from '../migrate.js';
import { createSignature, updateSignature, DuplicateSignatureError } from './mapWrite.js';

const dbReady = await ensureIntegrationDb();

// One row per scan id per system. Two pilots pasting the same scan a moment
// apart each see it missing locally and both POST it; the database is what
// makes the second one land on the first.

const blank = { sigType: 'unknown', name: '', notes: '', whType: '', whLeadsTo: '', ghostType: '', massStatus: '', timeStatus: '' };

async function mapWithSystem(userId: number): Promise<[string, string]> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO maps (user_id, name) VALUES ($1, 'm') RETURNING id`, [userId]);
  const sysId = randomUUID();
  await db.query(
    `INSERT INTO map_systems (id, map_id, eve_system_id, name, system_class) VALUES ($1, $2, 31000123, 'J123', 'C3')`,
    [sysId, rows[0].id]);
  return [rows[0].id, sysId];
}

const sigCount = async (systemId: string) =>
  (await db.query(`SELECT 1 FROM map_signatures WHERE system_id = $1`, [systemId])).rowCount;

describe.skipIf(!dbReady)('signature scan-id uniqueness (integration)', () => {
  let user: number, mapId: string, sysId: string;
  const actor = () => ({ userId: user, clientId: null });

  beforeEach(async () => {
    await truncateAll();
    user = await seedUser({ characterId: 101, role: 'admin' });
    [mapId, sysId] = await mapWithSystem(user);
  });

  it('two concurrent creates of one id leave one row, filling blanks from the second', async () => {
    const [a, b] = await Promise.all([
      createSignature(mapId, sysId, { ...blank, sigId: 'ZPO-946', sigType: 'wormhole', whType: 'B449' }, actor()),
      createSignature(mapId, sysId, { ...blank, sigId: 'zpo-946', whLeadsTo: 'Hi-Sec', timeStatus: 'lt24h' }, actor()),
    ]);
    expect(await sigCount(sysId)).toBe(1);
    expect(a.row.id).toBe(b.row.id);
    expect([a.inserted, b.inserted].sort()).toEqual([false, true]);
    const { rows } = await db.query(`SELECT sig_type, wh_type, wh_leads_to, time_status FROM map_signatures WHERE system_id = $1`, [sysId]);
    expect(rows[0]).toEqual({ sig_type: 'wormhole', wh_type: 'B449', wh_leads_to: 'Hi-Sec', time_status: 'lt24h' });
  });

  it('a merge never overwrites a filled field', async () => {
    await createSignature(mapId, sysId, { ...blank, sigId: 'ABC-123', whLeadsTo: 'Bille' }, actor());
    await createSignature(mapId, sysId, { ...blank, sigId: 'ABC-123', whLeadsTo: 'Hi-Sec' }, actor());
    const { rows } = await db.query(`SELECT wh_leads_to FROM map_signatures WHERE system_id = $1`, [sysId]);
    expect(rows).toEqual([{ wh_leads_to: 'Bille' }]);
  });

  it('a re-paste of an unscanned sig keeps a type set by hand', async () => {
    // Marked a wormhole by hand, then pasted again while the scanner only shows
    // "Cosmic Signature" (no type, no name): nothing known may be reset.
    await createSignature(mapId, sysId, { ...blank, sigId: 'GHJ-321', sigType: 'wormhole', whType: 'B274' }, actor());
    const { row } = await createSignature(mapId, sysId, { ...blank, sigId: 'GHJ-321', sigType: 'unknown' }, actor());
    expect(row).toMatchObject({ sigType: 'wormhole', whType: 'B274' });
  });

  it('blank ids are exempt', async () => {
    await createSignature(mapId, sysId, { ...blank, sigId: '' }, actor());
    await createSignature(mapId, sysId, { ...blank, sigId: '' }, actor());
    expect(await sigCount(sysId)).toBe(2);
  });

  it('renaming onto an existing id is refused', async () => {
    await createSignature(mapId, sysId, { ...blank, sigId: 'ABC-123' }, actor());
    const { row } = await createSignature(mapId, sysId, { ...blank, sigId: 'DEF-456' }, actor());
    await expect(updateSignature(mapId, sysId, row.id, { sigId: 'abc-123' }, actor()))
      .rejects.toBeInstanceOf(DuplicateSignatureError);
  });

  it('the migration merges pre-existing duplicates and re-points connections', async () => {
    await db.query(`DROP INDEX uq_map_signatures_system_sig`);
    const ins = async (createdAt: string, cols: Record<string, string>) => (await db.query<{ id: string }>(
      `INSERT INTO map_signatures (system_id, sig_id, created_at, sig_type, wh_type, wh_leads_to, time_status)
       VALUES ($1, 'ZPO-946', $2, $3, $4, $5, $6) RETURNING id`,
      [sysId, createdAt, cols.sigType ?? 'unknown', cols.whType ?? '', cols.whLeadsTo ?? '', cols.timeStatus ?? ''])).rows[0].id;
    const keep = await ins('2026-10-21T10:00:00Z', { sigType: 'wormhole', whType: 'B449', whLeadsTo: 'Bille' });
    const dup  = await ins('2026-10-21T10:00:01Z', { sigType: 'wormhole', whType: 'B449', whLeadsTo: 'Hi-Sec', timeStatus: 'lt24h' });
    const other = randomUUID();
    await db.query(`INSERT INTO map_systems (id, map_id, eve_system_id, name, system_class) VALUES ($1, $2, 30002647, 'Bille', 'HS')`, [other, mapId]);
    await db.query(
      `INSERT INTO map_connections (id, map_id, source_id, target_id, source_signature_id) VALUES ($1, $2, $3, $4, $5)`,
      [randomUUID(), mapId, sysId, other, dup]);

    await migrate();

    const { rows } = await db.query(`SELECT id, wh_leads_to, time_status FROM map_signatures WHERE system_id = $1`, [sysId]);
    expect(rows).toEqual([{ id: keep, wh_leads_to: 'Bille', time_status: 'lt24h' }]);
    const conn = await db.query(`SELECT source_signature_id FROM map_connections WHERE map_id = $1`, [mapId]);
    expect(conn.rows[0].source_signature_id).toBe(keep);
    const idx = await db.query(`SELECT 1 FROM pg_indexes WHERE indexname = 'uq_map_signatures_system_sig'`);
    expect(idx.rowCount).toBe(1);
  });
});
