// Live SDE values for the wormhole type chart (WhTypeChartModal), in the
// chart's own label formats. Each returns null when the SDE has no value, or
// one the column doesn't list, so the chart's bundled value stands in.
import { WH_JUMP_MASS } from './wormholeSize';
import { MASS_ORDER, LIFE_ORDER, type ShipSize } from '../data/whTypeChart';

// The chart's ship-size column is derived live from the SDE per-jump cap
// (wormholeMaxJumpMass) so it can't drift from a CCP rebalance. Maps to the
// chart's five descriptive tiers; null when a code has no dogma (keeps the
// curated value).
export function shipSizeFromSde(
  code: string,
  whTypes: Record<string, { maxJumpMass?: number } | undefined>,
): ShipSize | null {
  const m = whTypes[code.toUpperCase()]?.maxJumpMass;
  if (!m) return null;
  if (m >= WH_JUMP_MASS.capital) return 'up to Capital';
  if (m >= WH_JUMP_MASS.xl)      return 'up to Freighter';
  if (m >= WH_JUMP_MASS.large)   return 'up to Battleship';
  if (m >= WH_JUMP_MASS.medium)  return 'up to Battlecruiser';
  return 'up to Destroyer';
}

type WhTypes = Record<string, { totalMass?: number; lifetimeHours?: number } | undefined>;

// The SDE's total mass in the chart's own label format ("5 000 000 000 kg"),
// or null when the SDE has none or the value isn't one the column lists (a new
// value would have no row to draw a line to).
export function totalMassFromSde(code: string, whTypes: WhTypes): string | null {
  const m = whTypes[code.toUpperCase()]?.totalMass;
  if (!m) return null;
  const label = `${m.toLocaleString('en-US').replace(/,/g, ' ')} kg`;
  return MASS_ORDER.includes(label) ? label : null;
}

// The SDE's lifetime as the chart's label ("16h", "4.5h"), on the same terms.
export function lifetimeFromSde(code: string, whTypes: WhTypes): string | null {
  const h = whTypes[code.toUpperCase()]?.lifetimeHours;
  if (!h) return null;
  const label = `${h}h`;
  return LIFE_ORDER.includes(label) ? label : null;
}

