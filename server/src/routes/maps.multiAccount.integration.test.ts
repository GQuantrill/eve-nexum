import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const state = vi.hoisted(() => ({ over: {} as Record<string, unknown> }));
vi.mock('../config.js', async (importActual) => {
  const base = (await importActual<typeof import('../config.js')>()).config as Record<string, unknown>;
  return { config: new Proxy({}, { get: (_t, k: string) => (k in state.over ? state.over[k] : base[k]) }) };
});
// The share-create endpoint resolves the target's name best-effort; keep ESI out.
vi.mock('../services/entityNames.js', () => ({ resolveEntityNames: vi.fn(async () => new Map()) }));

import { ensureIntegrationDb, truncateAll, seedUser } from '../test/integrationDb.js';
import { db } from '../db.js';
import { mapsRouter } from './maps.js';

const dbReady = await ensureIntegrationDb();

interface U { id: number; characterId: number }

function makeApp(u: U) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { session: Record<string, unknown> }).session = {
      userId: u.id, characterId: u.characterId, role: 'full',
      userCorpId: null, userAllianceId: null, ownerId: null,
    };
    next();
  });
  app.use('/api/maps', mapsRouter);
  return app;
}

async function newOwner(): Promise<number> {
  const { rows } = await db.query<{ id: number }>(`INSERT INTO owners DEFAULT VALUES RETURNING id`);
  return rows[0].id;
}
async function newCharacter(characterId: number, ownerId: number): Promise<U> {
  const id = await seedUser({ characterId, role: 'full' });
  await db.query(`UPDATE users SET owner_id = $1 WHERE id = $2`, [ownerId, id]);
  return { id, characterId };
}
async function personalMap(creator: U, ownerId: number): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO maps (user_id, name, owner_id) VALUES ($1, 'Chain', $2) RETURNING id`,
    [creator.id, ownerId],
  );
  return rows[0].id;
}

// A personal map belongs to an ACCOUNT, not to the character who happened to
// create it — getMapAccess has always said so. Sharing and deleting re-derived
// ownership by comparing the creating character against the session instead, so
// an alt could open and edit a map its own account made but could not share it
// (403 "Only the owner can share this map") or delete it.
describe.skipIf(!dbReady)('personal maps are owned by the account, not the character', () => {
  let ownerId: number, main: U, alt: U, mapId: string, stranger: U;

  beforeEach(async () => {
    await truncateAll();
    state.over = { corpMode: false, allianceMode: false, restrictedMode: false, corpIds: [], allianceIds: [] };

    ownerId = await newOwner();
    main    = await newCharacter(1001, ownerId);
    alt     = await newCharacter(1002, ownerId);       // same account
    mapId   = await personalMap(main, ownerId);        // created by main

    stranger = await newCharacter(2001, await newOwner());  // a different account
  });

  it('lets the creating character share it', async () => {
    await request(makeApp(main))
      .post(`/api/maps/${mapId}/shares`)
      .send({ kind: 'character', targetId: 3001, canWrite: false })
      .expect(201);
  });

  // The reported bug.
  it('lets an ALT of the same account share it', async () => {
    const res = await request(makeApp(alt))
      .post(`/api/maps/${mapId}/shares`)
      .send({ kind: 'character', targetId: 3001, canWrite: false });
    expect(res.status).toBe(201);
  });

  it('lets an alt read the share list', async () => {
    await request(makeApp(alt)).get(`/api/maps/${mapId}/shares`).expect(200);
  });

  it('lets an alt delete a map its own account created', async () => {
    await request(makeApp(alt)).delete(`/api/maps/${mapId}`).expect(200);
    const { rowCount } = await db.query(`SELECT 1 FROM maps WHERE id = $1`, [mapId]);
    expect(rowCount).toBe(0);
  });

  // The other half: widening ownership to the account must not widen it further.
  // Someone with no access at all gets 404 rather than 403 — deliberate, since
  // 403 would confirm the map exists to a stranger who guessed its id.
  it('still hides the map from a character on a DIFFERENT account', async () => {
    const res = await request(makeApp(stranger))
      .post(`/api/maps/${mapId}/shares`)
      .send({ kind: 'character', targetId: 3001, canWrite: false });
    expect(res.status).toBe(404);
  });

  it('still refuses a delete from a different account', async () => {
    await request(makeApp(stranger)).delete(`/api/maps/${mapId}`).expect(404);
    const { rowCount } = await db.query(`SELECT 1 FROM maps WHERE id = $1`, [mapId]);
    expect(rowCount).toBe(1);
  });

  // Someone the map was shared WITH can open it, but must not be able to pass it
  // on or delete it.
  it('still refuses a share RECIPIENT re-sharing or deleting it', async () => {
    await db.query(
      `INSERT INTO map_shares (map_id, target_character_id, granted_by_user_id, can_write)
       VALUES ($1, $2, $3, TRUE)`,
      [mapId, stranger.characterId, main.id],
    );
    const share = await request(makeApp(stranger))
      .post(`/api/maps/${mapId}/shares`)
      .send({ kind: 'character', targetId: 3001, canWrite: false });
    expect(share.status).toBe(403);
    await request(makeApp(stranger)).delete(`/api/maps/${mapId}`).expect(403);
  });
});
