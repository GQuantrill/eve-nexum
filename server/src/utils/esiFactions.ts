import { esiFetch } from './esi.js';

export interface EsiFaction {
  faction_id:      number;
  name:            string;
  corporation_id?: number;
}

// The ESI faction list is static-ish reference data; fetched once and shared
// (incursions + insurgency both map pirate-faction ids to names/logos).
let factionMap: Map<number, EsiFaction> | null = null;

export async function loadFactions(): Promise<Map<number, EsiFaction>> {
  if (factionMap) return factionMap;
  const res = await esiFetch('https://esi.evetech.net/latest/universe/factions/?datasource=tranquility');
  if (!res.ok) throw new Error(`ESI factions ${res.status}`);
  const list = await res.json() as EsiFaction[];
  factionMap = new Map(list.map((f) => [f.faction_id, f]));
  return factionMap;
}

// A faction's logo is its corporation's logo (factions have no logo endpoint).
export function factionLogoUrl(faction: EsiFaction | undefined): string {
  return faction?.corporation_id
    ? `https://images.evetech.net/corporations/${faction.corporation_id}/logo?size=64`
    : '';
}
