import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

// Mock config (real db) with a live-mutable override so we can put the install
// into corp+alliance restricted mode.
const state = vi.hoisted(() => ({ over: {} as Record<string, unknown> }));
vi.mock('../config.js', async (importActual) => {
  const base = (await importActual<typeof import('../config.js')>()).config as Record<string, unknown>;
  return { config: new Proxy({}, { get: (_t, k: string) => (k in state.over ? state.over[k] : base[k]) }) };
});
// Avoid ESI: the share-create endpoint resolves target names best-effort.
vi.mock('../services/entityNames.js', () => ({
  resolveEntityNames: vi.fn(async () => new Map()),
}));

import { ensureIntegrationDb, truncateAll, seedUser } from '../test/integrationDb.js';
import { db } from '../db.js';
import { getMapAccess, requireMapContentWrite, mapsRouter } from './maps.js';
import { listVisibleMaps } from '../services/mapRead.js';

const dbReady = await ensureIntegrationDb();

interface U { id: number; characterId: number; corpId: number | null; allianceId: number | null; role: string }
async function mkUser(o: { characterId: number; corpId?: number | null; allianceId?: number | null; role?: string }): Promise<U> {
  const role = o.role ?? 'full';
  const id = await seedUser({ characterId: o.characterId, corpId: o.corpId ?? null, allianceId: o.allianceId ?? null, role });
  return { id, characterId: o.characterId, corpId: o.corpId ?? null, allianceId: o.allianceId ?? null, role };
}
// Minimal req/res doubles — getMapAccess/requireMapContentWrite read req.session
// via authUser and write to res.status().json().
const reqFor = (u: U) => ({ session: {
  userId: u.id, characterId: u.characterId, role: u.role,
  userCorpId: u.corpId, userAllianceId: u.allianceId, ownerId: null,
} }) as unknown as express.Request;
function fakeRes() {
  return { statusCode: 200, body: null as unknown,
           status(c: number) { this.statusCode = c; return this; },
           json(b: unknown) { this.body = b; return this; } };
}
const seedCorpMap = async (userId: number, corpId: number): Promise<string> =>
  (await db.query<{ id: string }>(`INSERT INTO maps (user_id, name, corp_id) VALUES ($1, 'Corp Map', $2) RETURNING id`, [userId, corpId])).rows[0].id;
const seedAllianceMap = async (userId: number, allianceId: number): Promise<string> =>
  (await db.query<{ id: string }>(`INSERT INTO maps (user_id, name, alliance_id) VALUES ($1, 'Ally Map', $2) RETURNING id`, [userId, allianceId])).rows[0].id;
const seedShare = (mapId: string, col: 'target_character_id' | 'target_corp_id' | 'target_alliance_id', targetId: number, canWrite: boolean, by: number) =>
  db.query(`INSERT INTO map_shares (map_id, ${col}, granted_by_user_id, can_write) VALUES ($1, $2, $3, $4)`, [mapId, targetId, by, canWrite]);

function makeApp(u: U) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { session: Record<string, unknown> }).session = {
      userId: u.id, characterId: u.characterId, role: u.role,
      userCorpId: u.corpId, userAllianceId: u.allianceId, ownerId: null,
    };
    next();
  });
  app.use('/api/maps', mapsRouter);
  return app;
}

describe.skipIf(!dbReady)('sharing corp/alliance maps (integration — real SQL)', () => {
  let owner: U, member: U, outsider: U, admin: U;
  beforeEach(async () => {
    await truncateAll();
    state.over = { corpMode: true, corpIds: [1000], allianceMode: true, allianceIds: [3000],
                   restrictedMode: true, corpMapShared: false, allianceMapShared: false };
    owner    = await mkUser({ characterId: 900, corpId: 1000, role: 'full' });
    member   = await mkUser({ characterId: 901, corpId: 1000, role: 'full' });
    outsider = await mkUser({ characterId: 902, corpId: 2000, role: 'full' });
    admin    = await mkUser({ characterId: 903, corpId: 1000, role: 'admin' });
  });

  it('a non-member has NO access to a corp map until it is shared', async () => {
    const mapId = await seedCorpMap(owner.id, 1000);
    expect(await getMapAccess(mapId, reqFor(outsider))).toBeNull();
  });

  it('a character share grants a non-member read access with the grant’s can_write', async () => {
    const mapId = await seedCorpMap(owner.id, 1000);
    await seedShare(mapId, 'target_character_id', outsider.characterId, false, owner.id);
    const access = await getMapAccess(mapId, reqFor(outsider));
    expect(access?.accessKind).toBe('shared');
    expect(access?.shareCanWrite).toBe(false);
  });

  it('a view-only share cannot write content; upgrading to edit lets it write', async () => {
    const mapId = await seedCorpMap(owner.id, 1000);
    await seedShare(mapId, 'target_character_id', outsider.characterId, false, owner.id);
    const ro = fakeRes();
    expect(await requireMapContentWrite(ro as unknown as express.Response, mapId, reqFor(outsider))).toBeNull();
    expect(ro.statusCode).toBe(403);

    await db.query(`UPDATE map_shares SET can_write = TRUE WHERE map_id = $1`, [mapId]);
    const rw = fakeRes();
    const acc = await requireMapContentWrite(rw as unknown as express.Response, mapId, reqFor(outsider));
    expect(acc?.accessKind).toBe('shared');
    expect(rw.statusCode).toBe(200);
  });

  it('an EDIT share still respects the recipient’s role — a readonly recipient cannot write', async () => {
    // Share to corp 2000 with edit; a readonly-role member of 2000 still can't
    // write (normal roles apply past the share), while a full-role member can.
    const mapId = await seedCorpMap(owner.id, 1000);
    await seedShare(mapId, 'target_corp_id', 2000, true, owner.id); // EDIT share to corp 2000
    const roMember = await mkUser({ characterId: 910, corpId: 2000, role: 'readonly' });

    // Read access is granted...
    const acc = await getMapAccess(mapId, reqFor(roMember));
    expect(acc?.accessKind).toBe('shared');
    expect(acc?.shareCanWrite).toBe(true);
    // ...but the readonly role blocks writing.
    const ro = fakeRes();
    expect(await requireMapContentWrite(ro as unknown as express.Response, mapId, reqFor(roMember))).toBeNull();
    expect(ro.statusCode).toBe(403);

    // The full-role outsider (also corp 2000) writes fine under the same share.
    const rw = fakeRes();
    expect(await requireMapContentWrite(rw as unknown as express.Response, mapId, reqFor(outsider))).not.toBeNull();
    expect(rw.statusCode).toBe(200);
  });

  it('a corp member keeps corp_member access (a view-only share must not downgrade it)', async () => {
    const mapId = await seedCorpMap(owner.id, 1000);
    await seedShare(mapId, 'target_corp_id', 1000, false, owner.id); // view-only share to own corp
    const access = await getMapAccess(mapId, reqFor(member));
    expect(access?.accessKind).toBe('corp_member');            // matched before the share branch
    const res = fakeRes();
    expect(await requireMapContentWrite(res as unknown as express.Response, mapId, reqFor(member))).not.toBeNull();
  });

  it('alliance maps accept shares too', async () => {
    const allyMap = await seedAllianceMap(owner.id, 3000);
    const allyOutsider = await mkUser({ characterId: 904, corpId: 2000, allianceId: 4000, role: 'full' });
    expect(await getMapAccess(allyMap, reqFor(allyOutsider))).toBeNull();
    await seedShare(allyMap, 'target_alliance_id', 4000, true, owner.id);
    const access = await getMapAccess(allyMap, reqFor(allyOutsider));
    expect(access?.accessKind).toBe('shared');
    expect(access?.shareCanWrite).toBe(true);
  });

  it('the shared corp map appears in the recipient’s visible map list, flagged sharedWithMe', async () => {
    const mapId = await seedCorpMap(owner.id, 1000);
    await seedShare(mapId, 'target_character_id', outsider.characterId, false, owner.id);
    const maps = await listVisibleMaps({
      userId: outsider.id, ownerId: null, userCorpId: outsider.corpId,
      userAllianceId: outsider.allianceId, callerChar: outsider.characterId,
    });
    const row = maps.find((m: { id: string }) => m.id === mapId);
    expect(row).toBeTruthy();
    expect((row as { sharedWithMe: boolean }).sharedWithMe).toBe(true);
  });

  it('only a corp admin can manage a corp map’s shares (requireShareAdmin)', async () => {
    const mapId = await seedCorpMap(owner.id, 1000);
    // A non-admin corp member is refused.
    const r1 = await request(makeApp(member)).post(`/api/maps/${mapId}/shares`).send({ kind: 'character', targetId: 902, canWrite: false });
    expect(r1.status).toBe(403);
    // An admin can, and can_write round-trips.
    const r2 = await request(makeApp(admin)).post(`/api/maps/${mapId}/shares`).send({ kind: 'character', targetId: 905, canWrite: false });
    expect(r2.status).toBe(201);
    expect(r2.body.canWrite).toBe(false);
  });
});
