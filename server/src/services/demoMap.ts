import { randomUUID } from 'node:crypto';
import { db } from '../db.js';

// First-login starter map. A small chain so new users land on something
// readable instead of a blank canvas: Jita (home) → C2 → C4 → C5 main line,
// with a C3 → lowsec side branch off the C4.
//
// Real EVE system IDs are populated where they exist (Jita, Amamake); J-codes
// leave eve_system_id null, matching how the import path handles unknowns.
//
// No-op when the user already has any map.
export async function seedDemoMap(userId: number): Promise<void> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // owner_id is taken from the user's account so the starter map is
    // owner-scoped like every other map (the account exists by the time this
    // runs on first login).
    const mapRows = await client.query<{ id: string }>(
      `INSERT INTO maps (user_id, owner_id, name)
       SELECT $1, (SELECT owner_id FROM users WHERE id = $1), 'Demo Map'
       WHERE NOT EXISTS (SELECT 1 FROM maps WHERE user_id = $1)
       RETURNING id`,
      [userId],
    );
    if (mapRows.rowCount === 0) {
      await client.query('COMMIT');
      return;
    }
    const mapId = mapRows.rows[0].id;

    const ids = {
      jita:    randomUUID(),
      c2:      randomUUID(),
      c4:      randomUUID(),
      c5:      randomUUID(),
      c3:      randomUUID(),
      amamake: randomUUID(),
    };

    interface DemoSystem {
      id:       string;
      eveId:    number | null;
      name:     string;
      cls:      string;
      effect:   string;
      statics:  string[];
      region:   string | null;
      x:        number;
      y:        number;
      home:     boolean;
      status:   string;
    }
    const systems: DemoSystem[] = [
      { id: ids.jita,    eveId: 30000142, name: 'Jita',    cls: 'HS', effect: 'none',   statics: [],       region: 'The Forge', x: 0,   y: 0,    home: true,  status: 'visited' },
      { id: ids.c2,      eveId: null,     name: 'J164417', cls: 'C2', effect: 'none',   statics: ['B274'], region: null,        x: 240, y: 0,    home: false, status: 'visited' },
      { id: ids.c4,      eveId: null,     name: 'J160225', cls: 'C4', effect: 'none',   statics: ['X877'], region: null,        x: 480, y: 0,    home: false, status: 'visited' },
      { id: ids.c5,      eveId: null,     name: 'J152820', cls: 'C5', effect: 'pulsar', statics: ['H296'], region: null,        x: 720, y: -80,  home: false, status: 'unknown' },
      { id: ids.c3,      eveId: null,     name: 'J160650', cls: 'C3', effect: 'none',   statics: ['U210'], region: null,        x: 480, y: 200,  home: false, status: 'visited' },
      { id: ids.amamake, eveId: 30002537, name: 'Amamake', cls: 'LS', effect: 'none',   statics: [],       region: 'Heimatar',  x: 720, y: 200,  home: false, status: 'unknown' },
    ];

    const sysCols = 15;
    const sysPlaceholders: string[] = [];
    const sysValues: unknown[] = [];
    for (const s of systems) {
      const base = sysValues.length;
      sysPlaceholders.push(`(${Array.from({ length: sysCols }, (_, i) => `$${base + i + 1}`).join(',')})`);
      sysValues.push(
        s.id, mapId, s.eveId, s.name, s.cls,
        s.effect, s.statics, s.region, null,
        s.x, s.y, s.status, s.home, false, '',
      );
    }
    await client.query(
      `INSERT INTO map_systems
         (id, map_id, eve_system_id, name, system_class, effect, statics, region_name, npc_type,
          position_x, position_y, status, is_home, locked, notes)
       VALUES ${sysPlaceholders.join(',')}`,
      sysValues,
    );

    const connections: Array<{ src: string; tgt: string; size: string; whType: string }> = [
      { src: ids.jita,  tgt: ids.c2,      size: 'large', whType: 'B274' },
      { src: ids.c2,    tgt: ids.c4,      size: 'large', whType: 'K162' },
      { src: ids.c4,    tgt: ids.c5,      size: 'xl',    whType: 'X877' },
      { src: ids.c4,    tgt: ids.c3,      size: 'large', whType: 'K162' },
      { src: ids.c3,    tgt: ids.amamake, size: 'large', whType: 'U210' },
    ];
    const connCols = 7;
    const connPlaceholders: string[] = [];
    const connValues: unknown[] = [];
    for (const c of connections) {
      const base = connValues.length;
      connPlaceholders.push(`(${Array.from({ length: connCols }, (_, i) => `$${base + i + 1}`).join(',')})`);
      connValues.push(randomUUID(), mapId, c.src, c.tgt, 'standard', c.size, c.whType);
    }
    await client.query(
      `INSERT INTO map_connections
         (id, map_id, source_id, target_id, connection_type, size, wh_type)
       VALUES ${connPlaceholders.join(',')}`,
      connValues,
    );

    await client.query(
      `INSERT INTO map_signatures (system_id, sig_id, sig_type, name, wh_type, wh_leads_to)
       VALUES ($1, 'ABC-123', 'wormhole', 'Outbound to lowsec', 'U210', 'Amamake')`,
      [ids.c3],
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
