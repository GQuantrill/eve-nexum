import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';

import { ensureIntegrationDb, truncateAll, seedUser } from '../test/integrationDb.js';
import { db } from '../db.js';
import { connectionTypeError, isProtectedGate } from './connectionRules.js';

const dbReady = await ensureIntegrationDb();

// Stargates are fixed in the game: an Ansiblex can't stand in for one, and on a
// map protecting them a real gate can't be deleted or retyped. A 'gate' between
// systems that aren't neighbours is not a real gate, so it stays removable.

// Jita (30000142) - Perimeter (30000144) are gate neighbours; Amarr (30002187)
// is not adjacent to Jita.
const JITA = 30000142, PERIMETER = 30000144, AMARR = 30002187;

let mapId: string;

async function seedSystem(name: string, eveId: number | null): Promise<string> {
  const id = randomUUID();
  await db.query(
    `INSERT INTO map_systems (id, map_id, name, system_class, eve_system_id) VALUES ($1, $2, $3, 'HS', $4)`,
    [id, mapId, name, eveId]);
  return id;
}
async function seedLink(a: string, b: string, type: string): Promise<string> {
  const id = randomUUID();
  await db.query(
    `INSERT INTO map_connections (id, map_id, source_id, target_id, connection_type) VALUES ($1, $2, $3, $4, $5)`,
    [id, mapId, a, b, type]);
  return id;
}

describe.skipIf(!dbReady)('stargate connection rules (integration)', () => {
  beforeAll(async () => {
    // The SDE table isn't part of the app schema (scripts/setup-db.ts seeds it).
    await db.query(`
      CREATE TABLE IF NOT EXISTS map_stargates (
        id INTEGER PRIMARY KEY, system_id INTEGER NOT NULL,
        destination_gate_id INTEGER NOT NULL, destination_system_id INTEGER NOT NULL)`);
    await db.query(`
      INSERT INTO map_stargates (id, system_id, destination_gate_id, destination_system_id)
      VALUES (1, $1, 2, $2), (2, $2, 1, $1), (3, $3, 4, 30002188)
      ON CONFLICT (id) DO NOTHING`, [JITA, PERIMETER, AMARR]);
  });

  beforeEach(async () => {
    await truncateAll();
    const user = await seedUser({ characterId: 303, role: 'admin' });
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO maps (user_id, name) VALUES ($1, 'm') RETURNING id`, [user]);
    mapId = rows[0].id;
  });

  it('refuses an Ansiblex between stargate neighbours', async () => {
    expect(await connectionTypeError('jumpgate', { sourceEveId: JITA, targetEveId: PERIMETER })).not.toBeNull();
  });

  it('allows an Ansiblex between non-neighbouring k-space systems', async () => {
    expect(await connectionTypeError('jumpgate', { sourceEveId: JITA, targetEveId: AMARR })).toBeNull();
  });

  it('protects a real stargate by default', async () => {
    const c = await seedLink(await seedSystem('Jita', JITA), await seedSystem('Perimeter', PERIMETER), 'gate');
    expect(await isProtectedGate(mapId, c)).toBe(true);
  });

  it('does not protect a stargate when the map turns protection off', async () => {
    const c = await seedLink(await seedSystem('Jita', JITA), await seedSystem('Perimeter', PERIMETER), 'gate');
    await db.query(`UPDATE maps SET protect_gates = FALSE WHERE id = $1`, [mapId]);
    expect(await isProtectedGate(mapId, c)).toBe(false);
  });

  it('does not protect a "gate" between systems that are not neighbours', async () => {
    const c = await seedLink(await seedSystem('Jita', JITA), await seedSystem('Amarr', AMARR), 'gate');
    expect(await isProtectedGate(mapId, c)).toBe(false);
  });

  it('does not protect a wormhole between gate neighbours', async () => {
    const c = await seedLink(await seedSystem('Jita', JITA), await seedSystem('Perimeter', PERIMETER), 'standard');
    expect(await isProtectedGate(mapId, c)).toBe(false);
  });

  it('does not protect an edge with an unresolved end', async () => {
    const c = await seedLink(await seedSystem('Jita', JITA), await seedSystem('custom', null), 'gate');
    expect(await isProtectedGate(mapId, c)).toBe(false);
  });
});
