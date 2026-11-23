// A rolling plan: the passes a fleet means to make through a hole, in order,
// one line per pass. Each ship goes out and comes back, so its first pass is
// "out" (ends on the far side), its second "back", and so on. Walking the list
// from the mass already used gives every line its running total and what the
// hole might do on it, so a pilot planning "2 battleships and a HIC" knows
// which ship goes when, hot or cold, and which pass could close it -- with a
// ship still on the wrong side, or not.
//
// Local to the pilot planning it (like the roller and its undo stack); only
// the passes actually flown change the shared mass.

import { passOutcome, type PassOutcome } from './rolling';

export interface PlanShip {
  id: string;
  name: string;
  coldKg: number;
  hotKg: number;
}

export interface PlanLine {
  id: string;
  shipId: string;
  hot: boolean;
  /** Flown: its mass is already in the connection's mass used. */
  done: boolean;
}

export interface RollPlan {
  ships: PlanShip[];
  lines: PlanLine[];
}

export interface PlannedPass {
  line: PlanLine;
  ship: PlanShip | undefined;
  kg: number;
  /** This ship's pass ends on the far side. */
  out: boolean;
  /** Mass used once this pass is through (flown passes: null, already counted). */
  usedAfter: number | null;
  /** Whether the hole can close on this pass (flown passes: null). */
  outcome: PassOutcome | null;
  /** Could close with this ship on the far side. */
  strands: boolean;
}

export const EMPTY_PLAN: RollPlan = { ships: [], lines: [] };

/** Walk the plan from the mass used now. Flown lines are already counted in
 *  `massUsed`, so the running total starts at the first line not yet flown. */
export function planPasses(totalMass: number, massUsed: number, plan: RollPlan): PlannedPass[] {
  const passesSoFar = new Map<string, number>();
  let used = massUsed;
  return plan.lines.map((line) => {
    const ship = plan.ships.find((s) => s.id === line.shipId);
    const kg = ship ? (line.hot ? ship.hotKg : ship.coldKg) : 0;
    const n = passesSoFar.get(line.shipId) ?? 0;
    passesSoFar.set(line.shipId, n + 1);
    const out = n % 2 === 0;
    if (line.done) return { line, ship, kg, out, usedAfter: null, outcome: null, strands: false };
    const outcome = passOutcome(totalMass, used, kg);
    used += kg;
    return { line, ship, kg, out, usedAfter: used, outcome, strands: out && outcome !== 'safe' };
  });
}

/** "BS 2": the ship's short name plus a number, the next free one. */
export function nextShipName(base: string, ships: PlanShip[]): string {
  let n = 1;
  while (ships.some((s) => s.name === `${base} ${n}`)) n++;
  return `${base} ${n}`;
}

const planKey = (connId: string) => `nexum.rollPlan.${connId}`;

export function loadPlan(connId: string | undefined): RollPlan {
  if (!connId) return EMPTY_PLAN;
  try {
    const raw = localStorage.getItem(planKey(connId));
    if (raw) {
      const p = JSON.parse(raw) as Partial<RollPlan>;
      const ships = (Array.isArray(p.ships) ? p.ships : []).filter((s): s is PlanShip =>
        !!s && typeof s.id === 'string' && typeof s.name === 'string'
        && typeof s.coldKg === 'number' && typeof s.hotKg === 'number');
      const ids = new Set(ships.map((s) => s.id));
      const lines = (Array.isArray(p.lines) ? p.lines : []).filter((l): l is PlanLine =>
        !!l && typeof l.id === 'string' && ids.has(l.shipId)).map((l) => ({ ...l, hot: !!l.hot, done: !!l.done }));
      return { ships, lines };
    }
  } catch { /* quota / private mode / bad json */ }
  return EMPTY_PLAN;
}

export function savePlan(connId: string, plan: RollPlan): void {
  try {
    if (!plan.ships.length && !plan.lines.length) localStorage.removeItem(planKey(connId));
    else localStorage.setItem(planKey(connId), JSON.stringify(plan));
  } catch { /* ignore */ }
}
