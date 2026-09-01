import { randomUUID } from 'node:crypto';
import { db } from '../db.js';

// First-login starter map. A small chain so new users land on something
// readable instead of a blank canvas:
//
//   Jita ──B274── J150137 (C2) ──Y683── J150026 (C4) ──C247── J150048 (C3) ──U210── Amamake
//                                            └──X877── J150044 (C4)
//
// Every system is real and every connection is one of its actual statics. The
// class/effect/statics below are only a fallback: seedDemoMap looks each system
// up in the SDE and uses the live row, so the starter map can't drift from the
// game the way the previous hand-written data had (it carried static sets that
// can't occur — the wormhole catalogue's `src` records which class each code
// comes from, and wormholers spot an impossible one immediately).
//
// eve_system_id is filled from the SDE too, J-codes included, so the starter
// map behaves like a real one rather than a set of detached placeholders.
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
      c4b:     randomUUID(),
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
      { id: ids.jita,    eveId: 30000142, name: 'Jita',    cls: 'HS', effect: 'none',       statics: [],               region: 'The Forge', x: 0,   y: 0,    home: true,  status: 'visited' },
      { id: ids.c2,      eveId: null,     name: 'J150137', cls: 'C2', effect: 'none',       statics: ['B274', 'Y683'], region: null,        x: 240, y: 0,    home: false, status: 'visited' },
      { id: ids.c4,      eveId: null,     name: 'J150026', cls: 'C4', effect: 'wolf_rayet', statics: ['C247', 'X877'], region: null,        x: 480, y: 0,    home: false, status: 'visited' },
      { id: ids.c4b,     eveId: null,     name: 'J150044', cls: 'C4', effect: 'none',       statics: ['C247', 'X877'], region: null,        x: 720, y: -80,  home: false, status: 'unknown' },
      { id: ids.c3,      eveId: null,     name: 'J150048', cls: 'C3', effect: 'none',       statics: ['U210'],         region: null,        x: 480, y: 200,  home: false, status: 'visited' },
      { id: ids.amamake, eveId: 30002537, name: 'Amamake', cls: 'LS', effect: 'none',       statics: [],               region: 'Heimatar',  x: 720, y: 200,  home: false, status: 'unknown' },
    ];

    // Overlay the SDE's own row for each system, so class / effect / statics and
    // the EVE id are whatever the game actually says. Systems missing from the
    // SDE (not seeded yet) keep the fallback values above.
    const { rows: sde } = await client.query<{
      id: number; name: string; systemClass: string | null; effect: string | null; statics: string[] | null;
    }>(
      `SELECT id, name, class AS "systemClass", effect, statics
         FROM solar_systems WHERE name = ANY($1::text[])`,
      [systems.map((s) => s.name)],
    );
    const sdeByName = new Map(sde.map((r) => [r.name, r]));
    for (const sys of systems) {
      const row = sdeByName.get(sys.name);
      if (!row) continue;
      sys.eveId = row.id;
      if (row.systemClass) sys.cls = row.systemClass;
      sys.effect = row.effect ?? 'none';
      if (row.statics) sys.statics = row.statics;
    }

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

    // Each hop is the static of the system it leaves from. All five codes have a
    // 375 Mkg jump limit in the SDE, i.e. 'large' — the previous X877 'xl' was
    // wrong, that size belongs to capital-passable holes like H296 (2 Gkg).
    const connections: Array<{ src: string; tgt: string; size: string; whType: string }> = [
      { src: ids.jita,  tgt: ids.c2,      size: 'large', whType: 'B274' },
      { src: ids.c2,    tgt: ids.c4,      size: 'large', whType: 'Y683' },
      { src: ids.c4,    tgt: ids.c3,      size: 'large', whType: 'C247' },
      { src: ids.c4,    tgt: ids.c4b,     size: 'large', whType: 'X877' },
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
       VALUES ($1, 'LPZ-471', 'wormhole', 'Outbound to lowsec', 'U210', 'Amamake')`,
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
