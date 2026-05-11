/**
 * Seeds a demo wormhole chain map for a given character.
 * Run: yarn seed-demo
 */
import 'dotenv/config';
import { db } from '../src/db.js';
import { randomUUID } from 'node:crypto';

const CHARACTER_ID = 1841929906;
const MAP_NAME     = 'Demo Chain';

// Chain layout positions
const POSITIONS: Record<string, { x: number; y: number }> = {
  home:  { x: 500,  y: 300 },
  c2a:   { x: 240,  y: 140 },
  c2b:   { x: 240,  y: 460 },
  c5a:   { x: 760,  y: 140 },
  hsa:   { x: 760,  y: 460 },
  c2c:   { x: 20,   y: 60  },
  nsa:   { x: 20,   y: 300  },
  lsa:   { x: 1000, y: 300 },
};

async function pickSystem(cls: string, exclude: number[] = []) {
  const excClause = exclude.length
    ? `AND id NOT IN (${exclude.join(',')})`
    : '';
  const { rows } = await db.query<{ id: number; name: string; effect: string | null; statics: string[] }>(
    `SELECT id, name, effect, statics
     FROM solar_systems
     WHERE class = $1 ${excClause}
     ORDER BY random()
     LIMIT 1`,
    [cls],
  );
  return rows[0] ?? null;
}

async function pickKspace(cls: string, exclude: number[] = []) {
  const excClause = exclude.length
    ? `AND ss.id NOT IN (${exclude.join(',')})`
    : '';
  const { rows } = await db.query<{ id: number; name: string }>(
    `SELECT ss.id, ss.name
     FROM solar_systems ss
     WHERE ss.class = $1 ${excClause}
       AND ss.security > 0.45
     ORDER BY random()
     LIMIT 1`,
    [cls],
  );
  return rows[0] ?? null;
}

async function main() {
  // Resolve user
  const { rows: userRows } = await db.query<{ id: number; character_name: string }>(
    `SELECT id, character_name FROM users WHERE character_id = $1`,
    [CHARACTER_ID],
  );
  if (!userRows.length) {
    console.error(`Character ${CHARACTER_ID} not found in users table. Log in first.`);
    process.exit(1);
  }
  const user = userRows[0];
  console.log(`Seeding demo map for ${user.character_name} (user id ${user.id})`);

  // Delete any existing demo map
  await db.query(`DELETE FROM maps WHERE user_id = $1 AND name = $2`, [user.id, MAP_NAME]);

  // Create map
  const mapId = randomUUID();
  await db.query(
    `INSERT INTO maps (id, user_id, name) VALUES ($1, $2, $3)`,
    [mapId, user.id, MAP_NAME],
  );
  console.log(`Created map: ${mapId}`);

  // Pick systems from the database
  const usedIds: number[] = [];
  const grab = async (cls: string) => {
    const s = await pickSystem(cls, usedIds);
    if (s) usedIds.push(s.id);
    return s;
  };
  const grabK = async (cls: string) => {
    const s = await pickKspace(cls, usedIds);
    if (s) usedIds.push(s.id);
    return s;
  };

  const home = await grab('C3');
  const c2a  = await grab('C2');
  const c2b  = await grab('C2');
  const c2c  = await grab('C2');
  const c5a  = await grab('C5');
  const hsa  = await grabK('HS');
  const nsa  = await grab('NS');
  const lsa  = await grabK('LS');

  const systems = [
    { key: 'home', sys: home, cls: 'C3', isHome: true,  status: 'active',  locked: true  },
    { key: 'c2a',  sys: c2a,  cls: 'C2', isHome: false, status: 'active',  locked: false },
    { key: 'c2b',  sys: c2b,  cls: 'C2', isHome: false, status: 'active',  locked: false },
    { key: 'c2c',  sys: c2c,  cls: 'C2', isHome: false, status: 'unknown', locked: false },
    { key: 'c5a',  sys: c5a,  cls: 'C5', isHome: false, status: 'active',  locked: false },
    { key: 'hsa',  sys: hsa,  cls: 'HS', isHome: false, status: 'active',  locked: false },
    { key: 'nsa',  sys: nsa,  cls: 'NS', isHome: false, status: 'unknown', locked: false },
    { key: 'lsa',  sys: lsa,  cls: 'LS', isHome: false, status: 'active',  locked: false },
  ].filter((s) => s.sys);

  // Insert systems
  const sysIdMap: Record<string, string> = {};
  for (const { key, sys, cls, isHome, status, locked } of systems) {
    if (!sys) continue;
    const id  = randomUUID();
    const pos = POSITIONS[key] ?? { x: 0, y: 0 };
    sysIdMap[key] = id;
    await db.query(
      `INSERT INTO map_systems
         (id, map_id, eve_system_id, name, system_class, effect, statics,
          position_x, position_y, status, is_home, locked)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [id, mapId, sys.id, sys.name, cls,
       sys.effect ?? 'none',
       sys.statics ?? [],
       pos.x, pos.y, status, isHome, locked],
    );
    console.log(`  + ${sys.name} (${cls})${isHome ? ' [HOME]' : ''}`);
  }

  // Insert connections
  type ConnDef = { from: string; to: string; mass: string; time: string; size: string; type: string };
  const connections: ConnDef[] = [
    { from: 'home', to: 'c2a',  mass: 'stable',       time: 'fresh',   size: 'large',  type: 'C247' },
    { from: 'home', to: 'c2b',  mass: 'destabilized', time: 'fresh',   size: 'large',  type: 'C247' },
    { from: 'home', to: 'c5a',  mass: 'critical',     time: 'eol',     size: 'large',  type: 'C140' },
    { from: 'home', to: 'hsa',  mass: 'stable',       time: 'fresh',   size: 'medium', type: 'E545' },
    { from: 'c2a',  to: 'c2c',  mass: 'stable',       time: 'fresh',   size: 'large',  type: 'B274' },
    { from: 'c2a',  to: 'nsa',  mass: 'stable',       time: 'fresh',   size: 'large',  type: 'D792' },
    { from: 'c2b',  to: 'lsa',  mass: 'stable',       time: 'fresh',   size: 'medium', type: 'E545' },
  ].filter((c) => sysIdMap[c.from] && sysIdMap[c.to]);

  for (const c of connections) {
    await db.query(
      `INSERT INTO map_connections
         (id, map_id, source_id, target_id, connection_type, mass_status, time_status, size)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [randomUUID(), mapId, sysIdMap[c.from], sysIdMap[c.to],
       c.type, c.mass, c.time, c.size],
    );
  }
  console.log(`  + ${connections.filter((c) => sysIdMap[c.from] && sysIdMap[c.to]).length} connections`);

  // Add signatures to the home system
  if (sysIdMap.home) {
    const sigs = [
      { sigId: 'ABC-123', type: 'wormhole', name: 'C247',  whType: 'C247',  leadsTo: 'C2' },
      { sigId: 'DEF-456', type: 'wormhole', name: 'C247',  whType: 'C247',  leadsTo: 'C2' },
      { sigId: 'GHI-789', type: 'wormhole', name: 'C140',  whType: 'C140',  leadsTo: 'C5' },
      { sigId: 'JKL-012', type: 'wormhole', name: 'E545',  whType: 'E545',  leadsTo: 'HS' },
      { sigId: 'MNO-345', type: 'combat',   name: 'Quarantine Zone', whType: '', leadsTo: '' },
      { sigId: 'PQR-678', type: 'data',     name: 'Unsecured Perimeter', whType: '', leadsTo: '' },
    ];
    for (const sig of sigs) {
      await db.query(
        `INSERT INTO map_signatures
           (system_id, sig_id, sig_type, name, wh_type, wh_leads_to)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [sysIdMap.home, sig.sigId, sig.type, sig.name, sig.whType, sig.leadsTo],
      );
    }
    console.log(`  + ${sigs.length} signatures on home`);
  }

  await db.end();
  console.log('\nDemo map seeded. Log in and switch to "Demo Chain" to see it.');
}

main().catch((err) => { console.error(err); process.exit(1); });
