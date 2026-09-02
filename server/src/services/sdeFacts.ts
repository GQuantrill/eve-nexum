import { db } from '../db.js';

/**
 * The facts about a solar system that come from CCP, not from the user: its
 * class, its wormhole effect, and its statics.
 *
 * These were accepted verbatim on every system write, so a real system could be
 * relabelled into something that doesn't exist — a C5 pulsar saved as a C1
 * wolf-rayet, or a C3 saved as hi-sec. Both were reported from the field and
 * both were found in live data.
 *
 * They're derived, not entered: whenever a system resolves to a real EVE id the
 * SDE row wins and whatever the client sent is ignored. Systems with no EVE id —
 * custom nodes, and the unmapped-wormhole placeholders — have no SDE row to
 * defer to, so they stay fully editable, which is what they're for.
 */
export interface SdeSystemFacts {
  systemClass: string | null;
  effect:      string;
  statics:     string[];
}

export async function sdeSystemFacts(eveSystemId: number | null | undefined): Promise<SdeSystemFacts | null> {
  if (eveSystemId == null) return null;
  try {
    const { rows } = await db.query<{ systemClass: string | null; effect: string | null; statics: string[] | null }>(
      `SELECT class AS "systemClass", effect, statics FROM solar_systems WHERE id = $1`,
      [eveSystemId],
    );
    if (!rows.length) return null;   // not in this SDE seed — nothing to defer to
    return {
      systemClass: rows[0].systemClass,
      effect:      rows[0].effect ?? 'none',
      statics:     rows[0].statics ?? [],
    };
  } catch {
    return null;                     // SDE unavailable — keep the client's values
  }
}
