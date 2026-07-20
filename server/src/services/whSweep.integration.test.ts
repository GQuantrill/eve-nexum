import { describe, it, expect, beforeEach, vi } from 'vitest';
import crypto from 'node:crypto';

// Mock config (real db) so we can toggle whether the connection-lifetime sweep
// is "enabled" — that's what decides whether whSweep defers manually-overridden
// holes to it.
const state = vi.hoisted(() => ({ connLifetimeSweepMinutes: 60 }));
vi.mock('../config.js', async (importActual) => {
  const base = (await importActual<typeof import('../config.js')>()).config as Record<string, unknown>;
  return { config: new Proxy({}, { get: (_t, k: string) => (k === 'connLifetimeSweepMinutes' ? state.connLifetimeSweepMinutes : base[k]) }) };
});

import { ensureIntegrationDb, truncateAll, seedUser } from '../test/integrationDb.js';
import { db } from '../db.js';
import { sweepAll } from './whSweep.js';

const dbReady = await ensureIntegrationDb();

async function seedMap(userId: number): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO maps (user_id, name, lazy_remove_wormholes) VALUES ($1, 'Sweep Map', TRUE) RETURNING id`, [userId]);
  return rows[0].id;
}
async function seedSystem(mapId: string, name: string): Promise<string> {
  const id = crypto.randomUUID();
  await db.query(`INSERT INTO map_systems (id, map_id, name, system_class) VALUES ($1, $2, $3, 'C4')`, [id, mapId, name]);
  return id;
}
// A wormhole sig aged well past its type's max life (D382 = 16h).
async function seedAgedSig(systemId: string, ageHours = 20): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO map_signatures (system_id, sig_id, sig_type, wh_type, created_at)
     VALUES ($1, $2, 'wormhole', 'D382', NOW() - ($3 || ' hours')::interval) RETURNING id`,
    [systemId, `ABC-${Math.floor(ageHours)}`, String(ageHours)]);
  return rows[0].id;
}
async function seedConn(mapId: string, srcSys: string, tgtSys: string, sigId: string, lifetimeExpiresAt: string | null): Promise<void> {
  await db.query(
    `INSERT INTO map_connections (id, map_id, source_id, target_id, connection_type, wh_type, source_signature_id, lifetime_expires_at)
     VALUES ($1, $2, $3, $4, 'standard', 'D382', $5, $6)`,
    [crypto.randomUUID(), mapId, srcSys, tgtSys, sigId, lifetimeExpiresAt]);
}
const sigExists = async (id: string): Promise<boolean> =>
  (await db.query(`SELECT 1 FROM map_signatures WHERE id = $1`, [id])).rows.length > 0;

describe.skipIf(!dbReady)('whSweep + connLifetime reconciliation (integration)', () => {
  let ownerId: number;
  beforeEach(async () => {
    await truncateAll();
    state.connLifetimeSweepMinutes = 60; // connLifetime sweep enabled by default
    ownerId = await seedUser({ characterId: 900 });
  });

  it('sweeps an aged auto hole but DEFERS one with a manual lifetime override', async () => {
    const mapId = await seedMap(ownerId);
    const a = await seedSystem(mapId, 'A');
    const b = await seedSystem(mapId, 'B');

    const autoSig = await seedAgedSig(a, 20);   // 20h old, no override → aged out
    await seedConn(mapId, a, b, autoSig, null);

    const overriddenSig = await seedAgedSig(a, 20); // 20h old, but its connection has an override
    await seedConn(mapId, a, b, overriddenSig, new Date(Date.now() + 10 * 3_600_000).toISOString());

    await sweepAll();

    expect(await sigExists(autoSig)).toBe(false);       // swept
    expect(await sigExists(overriddenSig)).toBe(true);  // deferred to connLifetime sweep
  });

  it('sweeps BOTH when the connection-lifetime sweep is disabled (no one to defer to)', async () => {
    state.connLifetimeSweepMinutes = 0; // disabled
    const mapId = await seedMap(ownerId);
    const a = await seedSystem(mapId, 'A');
    const b = await seedSystem(mapId, 'B');

    const autoSig = await seedAgedSig(a, 20);
    await seedConn(mapId, a, b, autoSig, null);
    const overriddenSig = await seedAgedSig(a, 20);
    await seedConn(mapId, a, b, overriddenSig, new Date(Date.now() + 10 * 3_600_000).toISOString());

    await sweepAll();

    expect(await sigExists(autoSig)).toBe(false);
    expect(await sigExists(overriddenSig)).toBe(false); // no defer target → swept too
  });

  it('leaves a fresh hole alone', async () => {
    const mapId = await seedMap(ownerId);
    const a = await seedSystem(mapId, 'A');
    const fresh = await seedAgedSig(a, 2); // 2h old, well within a 16h life
    await sweepAll();
    expect(await sigExists(fresh)).toBe(true);
  });
});
