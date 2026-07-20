import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'node:crypto';

import { ensureIntegrationDb, truncateAll, seedUser } from '../test/integrationDb.js';
import { db } from '../db.js';
import { mapsRouter } from './maps.js';

const dbReady = await ensureIntegrationDb();

// Bare app: the real mapsRouter (incl. requireAuth + the real access checks)
// behind a fake session. Personal maps owned by the session user need no config
// overrides — the owner passes requireMapWrite regardless of role.
function makeApp(userId: number) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { session: Record<string, unknown> }).session =
      { userId, characterId: 900, role: 'full', userCorpId: null, userAllianceId: null };
    next();
  });
  app.use('/api/maps', mapsRouter);
  return app;
}

async function seedMap(userId: number, name: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO maps (user_id, name) VALUES ($1, $2) RETURNING id`, [userId, name]);
  return rows[0].id;
}
async function seedSystem(mapId: string, eveId: number, name: string, notes = ''): Promise<string> {
  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO map_systems (id, map_id, eve_system_id, name, system_class, notes)
     VALUES ($1, $2, $3, $4, 'C4', $5)`, [id, mapId, eveId, name, notes]);
  return id;
}
async function seedSig(systemId: string, sigId: string, o: {
  sigType?: string; name?: string; notes?: string; whType?: string; whLeadsTo?: string;
} = {}): Promise<void> {
  await db.query(
    `INSERT INTO map_signatures (system_id, sig_id, sig_type, name, notes, wh_type, wh_leads_to)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [systemId, sigId, o.sigType ?? 'unknown', o.name ?? '', o.notes ?? '', o.whType ?? '', o.whLeadsTo ?? '']);
}
async function seedStruct(systemId: string, userId: number, o: {
  name: string; structureType?: string; ownerCorp?: string; eveId?: number | null; notes?: string; ownerCorpId?: number | null;
}): Promise<void> {
  await db.query(
    `INSERT INTO map_structures (system_id, name, structure_type, owner_corp, eve_id, notes, owner_corp_id, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [systemId, o.name, o.structureType ?? 'unknown', o.ownerCorp ?? '', o.eveId ?? null, o.notes ?? '', o.ownerCorpId ?? null, userId]);
}

describe.skipIf(!dbReady)('map merge (integration)', () => {
  let ownerId: number;
  let app: express.Express;

  beforeEach(async () => {
    await truncateAll();
    ownerId = await seedUser({ characterId: 900, role: 'full' });
    app = makeApp(ownerId);
  });

  it('folds sigs, structures and notes into the matched system — set-based UPDATEs + inserts', async () => {
    const EVE = 31000005;
    const destMap = await seedMap(ownerId, 'Dest Map');
    const srcMap  = await seedMap(ownerId, 'Source Map');

    // Same system on both maps (matched by eve_system_id).
    const destSys = await seedSystem(destMap, EVE, 'J131110', '');        // blank note
    const srcSys  = await seedSystem(srcMap,  EVE, 'J131110', 'keep me'); // note to fold in

    // ABC-123 collides (blank on dest, filled on source) → dest UPDATED.
    await seedSig(destSys, 'ABC-123');
    await seedSig(srcSys,  'ABC-123', { sigType: 'wormhole', name: 'K162', notes: 'src sig', whType: 'K162', whLeadsTo: 'C4' });
    // DEF-456 only on source → INSERTED on dest.
    await seedSig(srcSys, 'DEF-456', { sigType: 'wormhole', whType: 'D382', whLeadsTo: 'C2' });

    // Structure eve_id 1001 collides → UPDATED; eve_id 2002 new → INSERTED.
    await seedStruct(destSys, ownerId, { name: 'Astra', eveId: 1001 });
    await seedStruct(srcSys,  ownerId, { name: 'Astrahus', structureType: 'astrahus', ownerCorp: 'CorpX', ownerCorpId: 98000001, eveId: 1001, notes: 'src struct' });
    await seedStruct(srcSys,  ownerId, { name: 'Fort', structureType: 'fortizar', eveId: 2002 });

    const res = await request(app).post(`/api/maps/${destMap}/merge`).send({ sourceId: srcMap });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      added:   { systems: 0, connections: 0, signatures: 1, structures: 1 },
      updated: { signatures: 1, structures: 1, systemNotes: 1 },
    });

    // Note UPDATE (unnest) landed.
    const sys = await db.query<{ notes: string }>(`SELECT notes FROM map_systems WHERE id = $1`, [destSys]);
    expect(sys.rows[0].notes).toBe('keep me');

    // Sig collision UPDATED with the source's fields.
    const sig = await db.query<{ sig_type: string; name: string; notes: string; wh_type: string; wh_leads_to: string }>(
      `SELECT sig_type, name, notes, wh_type, wh_leads_to FROM map_signatures WHERE system_id = $1 AND sig_id = 'ABC-123'`, [destSys]);
    expect(sig.rows[0]).toMatchObject({ sig_type: 'wormhole', name: 'K162', notes: 'src sig', wh_type: 'K162', wh_leads_to: 'C4' });

    // New sig INSERTED with from_merge = TRUE (excluded from scan stats).
    const newSig = await db.query<{ wh_type: string; from_merge: boolean }>(
      `SELECT wh_type, from_merge FROM map_signatures WHERE system_id = $1 AND sig_id = 'DEF-456'`, [destSys]);
    expect(newSig.rows[0]).toMatchObject({ wh_type: 'D382', from_merge: true });

    // Structure collision UPDATED (incl. the int/bigint columns).
    const st = await db.query<{ name: string; structure_type: string; owner_corp: string; owner_corp_id: number; notes: string }>(
      `SELECT name, structure_type, owner_corp, owner_corp_id, notes FROM map_structures WHERE system_id = $1 AND eve_id = 1001`, [destSys]);
    expect(st.rows[0]).toMatchObject({ name: 'Astrahus', structure_type: 'astrahus', owner_corp: 'CorpX', owner_corp_id: 98000001, notes: 'src struct' });

    // New structure INSERTED.
    const newSt = await db.query<{ name: string }>(`SELECT name FROM map_structures WHERE system_id = $1 AND eve_id = 2002`, [destSys]);
    expect(newSt.rows[0].name).toBe('Fort');

    // The matched system was deduped, not duplicated.
    const cnt = await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM map_systems WHERE map_id = $1`, [destMap]);
    expect(cnt.rows[0].n).toBe(1);
  });

  it('honours include flags — notes/structures off leaves them untouched', async () => {
    const EVE = 31000006;
    const destMap = await seedMap(ownerId, 'Dest');
    const srcMap  = await seedMap(ownerId, 'Src');
    const destSys = await seedSystem(destMap, EVE, 'J111', '');
    const srcSys  = await seedSystem(srcMap,  EVE, 'J111', 'note');
    await seedSig(srcSys, 'GHI-789', { whType: 'A239' });
    await seedStruct(srcSys, ownerId, { name: 'SkipMe', eveId: 3003 });

    const res = await request(app).post(`/api/maps/${destMap}/merge`)
      .send({ sourceId: srcMap, include: { signatures: true, structures: false, notes: false } });
    expect(res.status).toBe(200);
    expect(res.body.updated.systemNotes).toBe(0);
    expect(res.body.added.structures).toBe(0);
    expect(res.body.added.signatures).toBe(1);

    const sys = await db.query<{ notes: string }>(`SELECT notes FROM map_systems WHERE id = $1`, [destSys]);
    expect(sys.rows[0].notes).toBe(''); // note NOT folded in

    const sig = await db.query(`SELECT 1 FROM map_signatures WHERE system_id = $1 AND sig_id = 'GHI-789'`, [destSys]);
    expect(sig.rows).toHaveLength(1);
    const st = await db.query(`SELECT 1 FROM map_structures WHERE system_id = $1`, [destSys]);
    expect(st.rows).toHaveLength(0); // structures skipped
  });

  it('rejects a merge into a map the caller does not own (404)', async () => {
    const other   = await seedUser({ characterId: 901 });
    const destMap = await seedMap(other, 'Not Yours');
    const srcMap  = await seedMap(ownerId, 'Mine');
    const res = await request(app).post(`/api/maps/${destMap}/merge`).send({ sourceId: srcMap });
    expect(res.status).toBe(404);
  });
});
