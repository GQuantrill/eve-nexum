import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const state = vi.hoisted(() => ({ over: {} as Record<string, unknown> }));
vi.mock('../config.js', async (importActual) => {
  const base = (await importActual<typeof import('../config.js')>()).config as Record<string, unknown>;
  return { config: new Proxy({}, { get: (_t, k: string) => (k in state.over ? state.over[k] : base[k]) }) };
});
vi.mock('../services/entityNames.js', () => ({ resolveEntityNames: vi.fn(async () => new Map()) }));

import { ensureIntegrationDb, truncateAll, seedUser } from '../test/integrationDb.js';
import { db } from '../db.js';
import { mapsRouter } from './maps.js';

const dbReady = await ensureIntegrationDb();

const OWNER_CORP = 1000;   // the corp that owns nothing — just where the sharer lives
const MY_CORP    = 2000;   // the recipients' corp, which the map gets shared with

interface U { id: number; characterId: number; corpId: number; ownerId: number }

/** A user with an account (owners row), as every real login has. */
async function mkUser(characterId: number, corpId: number, ownerId?: number): Promise<U> {
  const id = await seedUser({ characterId, corpId, role: 'full' });
  const oid = ownerId ?? (await db.query<{ id: number }>(
    `INSERT INTO owners DEFAULT VALUES RETURNING id`)).rows[0].id;
  await db.query(`UPDATE users SET owner_id = $1 WHERE id = $2`, [oid, id]);
  return { id, characterId, corpId, ownerId: oid };
}

function appFor(u: U) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { session: Record<string, unknown> }).session = {
      userId: u.id, characterId: u.characterId, role: 'full',
      userCorpId: u.corpId, userAllianceId: null, ownerId: null,  // forces the DB lookup
    };
    next();
  });
  app.use('/api/maps', mapsRouter);
  return app;
}

const listFor = async (u: U) =>
  (await request(appFor(u)).get('/api/maps').expect(200)).body.maps as
    { id: string; name: string; sharedWithMe?: boolean; canLeaveShare?: boolean; hiddenByMe?: boolean }[];

const leave   = (u: U, mapId: string) => request(appFor(u)).delete(`/api/maps/${mapId}/shares/mine`);
const restore = (u: U, mapId: string) => request(appFor(u)).post(`/api/maps/${mapId}/shares/mine/restore`);
const shareRows = async (mapId: string) =>
  (await db.query(`SELECT 1 FROM map_shares WHERE map_id = $1`, [mapId])).rowCount ?? 0;
const optoutRows = async (mapId: string) =>
  (await db.query(`SELECT 1 FROM map_share_optouts WHERE map_id = $1`, [mapId])).rowCount ?? 0;

describe.skipIf(!dbReady)('leaving a shared map (integration)', () => {
  let sharer: U, me: U, colleague: U, mapId: string;

  beforeEach(async () => {
    await truncateAll();
    state.over = { corpMode: true, corpIds: [OWNER_CORP, MY_CORP], corpMapShared: false,
                   allianceMode: false, restrictedMode: false };
    sharer    = await mkUser(900, OWNER_CORP);
    me        = await mkUser(901, MY_CORP);
    colleague = await mkUser(902, MY_CORP);
    // A PERSONAL map of the sharer's — not a corp map. What gets shared varies
    // per test; that is the whole distinction being exercised.
    mapId = (await db.query<{ id: string }>(
      `INSERT INTO maps (user_id, owner_id, name) VALUES ($1, $2, 'Zosh Scanned WH') RETURNING id`,
      [sharer.id, sharer.ownerId])).rows[0].id;
  });

  const shareToCharacter = () => db.query(
    `INSERT INTO map_shares (map_id, target_character_id, granted_by_user_id, can_write)
     VALUES ($1, $2, $3, FALSE)`, [mapId, me.characterId, sharer.id]);
  const shareToCorp = () => db.query(
    `INSERT INTO map_shares (map_id, target_corp_id, granted_by_user_id, can_write)
     VALUES ($1, $2, $3, FALSE)`, [mapId, MY_CORP, sharer.id]);

  describe('a grant made to my character', () => {
    it('is deleted outright, which is what takes me off the owner s list', async () => {
      await shareToCharacter();
      expect((await listFor(me)).find((m) => m.id === mapId)?.canLeaveShare).toBe(true);

      const r = await leave(me, mapId).expect(200);
      expect(r.body.kind).toBe('share-removed');
      expect(await shareRows(mapId)).toBe(0);    // gone from the owner's list
      expect(await optoutRows(mapId)).toBe(0);   // and no opt-out needed
      expect((await listFor(me)).some((m) => m.id === mapId)).toBe(false);
    });
  });

  describe('a grant made to my corp', () => {
    it('cannot be deleted, so it records an opt-out and spares everyone else', async () => {
      await shareToCorp();
      // The reported case: visible, but with nothing individual to give up.
      const before = (await listFor(me)).find((m) => m.id === mapId);
      expect(before?.sharedWithMe).toBe(true);
      expect(before?.canLeaveShare).toBe(false);

      const r = await leave(me, mapId).expect(200);
      expect(r.body.kind).toBe('opted-out');
      expect(await shareRows(mapId)).toBe(1);    // the corp grant is untouched
      expect(await optoutRows(mapId)).toBe(1);
    });

    it('leaves my colleague s list alone', async () => {
      // The reason an org grant cannot simply be deleted.
      await shareToCorp();
      await leave(me, mapId).expect(200);
      expect((await listFor(colleague)).some((m) => m.id === mapId)).toBe(true);
    });

    it('keeps returning the map to me, flagged, so there is a way back', async () => {
      await shareToCorp();
      await leave(me, mapId).expect(200);
      const mine = (await listFor(me)).find((m) => m.id === mapId);
      expect(mine?.hiddenByMe).toBe(true);
    });

    it('restores it', async () => {
      await shareToCorp();
      await leave(me, mapId).expect(200);
      await restore(me, mapId).expect(200);
      expect(await optoutRows(mapId)).toBe(0);
      expect((await listFor(me)).find((m) => m.id === mapId)?.hiddenByMe).toBe(false);
    });

    it('does not leave twice', async () => {
      await shareToCorp();
      await leave(me, mapId).expect(200);
      await leave(me, mapId).expect(200);
      expect(await optoutRows(mapId)).toBe(1);
    });

    it('applies to the whole account, not one character', async () => {
      // Personal maps are owner-scoped, so an alt must not see a map the main
      // has already left — otherwise switching character would undo it.
      await shareToCorp();
      await leave(me, mapId).expect(200);
      const alt = await mkUser(903, MY_CORP, me.ownerId);
      expect((await listFor(alt)).find((m) => m.id === mapId)?.hiddenByMe).toBe(true);
    });
  });

  it('refuses to record an opt-out against a map the caller cannot see', async () => {
    // Nothing is shared with them at all. Without the access check this would
    // accept any map id and accumulate rows.
    const stranger = await mkUser(904, 3000);
    await leave(stranger, mapId).expect(404);
    expect(await optoutRows(mapId)).toBe(0);
  });

  it('tells the owner how many have left', async () => {
    await shareToCorp();
    const owned = async () =>
      (await request(appFor(sharer)).get(`/api/maps/${mapId}/shares`).expect(200)).body;
    expect((await owned()).optedOut).toBe(0);
    await leave(me, mapId).expect(200);
    expect((await owned()).optedOut).toBe(1);
    // Still one grant — the count is the only thing that moved.
    expect((await owned()).shares).toHaveLength(1);
  });
});
