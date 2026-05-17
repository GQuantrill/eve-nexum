import { useEffect, useState } from 'react';

const ESI = 'https://esi.evetech.net/latest';

interface SovEntry {
  system_id:       number;
  alliance_id?:    number;
  corporation_id?: number;
  faction_id?:     number;
}

interface EntityInfo {
  name:   string;
  ticker: string;
}

interface FactionEntry {
  faction_id:     number;
  name:           string;
  corporation_id: number;
}

export interface SovResult {
  // Kept for SystemNode (shows one logo + name)
  controller: string;
  ticker?:    string;
  logoUrl?:   string;

  // Raw IDs so consumers (e.g. the Standings pane) can match against the
  // user's contact list. Populated whenever the corresponding entity is
  // present.
  allianceId?:    number;
  corporationId?: number;
  factionId?:     number;

  // Detailed breakdown for SystemPanel
  alliance?: { name: string; ticker: string; logoUrl: string };
  corp?:     { name: string; ticker: string; logoUrl: string };
  faction?:  { name: string; logoUrl: string };
}

// Exported so other hooks (e.g. useProximityAlerts) can iterate the
// cluster-wide sov data without re-fetching. Use via the exported
// `ensureSovLoaded()` + `getSovEntries()` helpers — callers shouldn't
// touch the map mutably.
const sovMap        = new Map<number, SovEntry>();
export function getSovEntries(): ReadonlyMap<number, Readonly<SovEntry>> { return sovMap; }
export function ensureSovLoaded(): Promise<void> { return ensureSovMap(); }
const infoCache     = new Map<string, EntityInfo>();
const infoInflight  = new Map<string, Promise<EntityInfo | null>>();
const factionsMap   = new Map<number, FactionEntry>();
let   sovLoad: Promise<void> | null      = null;
let   factionsLoad: Promise<void> | null = null;

async function ensureSovMap() {
  if (sovLoad) return sovLoad;
  sovLoad = fetch(`${ESI}/sovereignty/map/`)
    .then((r) => r.json())
    .then((entries: SovEntry[]) => { for (const e of entries) sovMap.set(e.system_id, e); })
    .catch(() => {});
  return sovLoad;
}

async function ensureFactions() {
  if (factionsLoad) return factionsLoad;
  factionsLoad = fetch(`${ESI}/universe/factions/`)
    .then((r) => r.json())
    .then((list: FactionEntry[]) => { for (const f of list) factionsMap.set(f.faction_id, f); })
    .catch(() => {});
  return factionsLoad;
}

async function fetchEntityInfo(type: 'alliances' | 'corporations', id: number): Promise<EntityInfo | null> {
  const key = `${type}:${id}`;
  if (infoCache.has(key)) return infoCache.get(key)!;
  const existing = infoInflight.get(key);
  if (existing) return existing;
  const promise = fetch(`${ESI}/${type}/${id}/`)
    .then((r) => {
      if (!r.ok) return null;
      return r.json() as Promise<{ name: string; ticker: string }>;
    })
    .then((d) => {
      if (!d) return null;
      const info: EntityInfo = { name: d.name, ticker: d.ticker };
      infoCache.set(key, info);
      return info;
    })
    .catch(() => null)
    .finally(() => infoInflight.delete(key));
  infoInflight.set(key, promise);
  return promise;
}

export function useSovData(eveSystemId: number | null): SovResult | null {
  const [sov, setSov] = useState<SovResult | null>(null);

  useEffect(() => {
    if (!eveSystemId) { setSov(null); return; }
    let cancelled = false;

    Promise.all([ensureSovMap(), ensureFactions()]).then(async () => {
      const entry = sovMap.get(eveSystemId);
      if (!entry || cancelled) return;
      const [allianceInfo, corpInfo] = await Promise.all([
        entry.alliance_id    ? fetchEntityInfo('alliances',    entry.alliance_id)    : Promise.resolve(null),
        entry.corporation_id ? fetchEntityInfo('corporations', entry.corporation_id) : Promise.resolve(null),
      ]);

      if (cancelled) return;

      const alliance = allianceInfo && entry.alliance_id ? {
        name:    allianceInfo.name,
        ticker:  allianceInfo.ticker,
        logoUrl: `https://images.evetech.net/alliances/${entry.alliance_id}/logo?size=64`,
      } : undefined;

      const corp = corpInfo && entry.corporation_id ? {
        name:    corpInfo.name,
        ticker:  corpInfo.ticker,
        logoUrl: `https://images.evetech.net/corporations/${entry.corporation_id}/logo?size=64`,
      } : undefined;

      const factionEntry = entry.faction_id ? factionsMap.get(entry.faction_id) : undefined;
      const faction = factionEntry ? {
        name:    factionEntry.name,
        logoUrl: `https://images.evetech.net/corporations/${entry.faction_id}/logo?size=64`,
      } : undefined;

      // Primary controller: alliance > corp > faction
      const primary = alliance ?? corp ?? faction;
      if (!primary) return;

      setSov({
        controller: primary.name,
        ticker:     (alliance ?? corp)?.ticker,
        logoUrl:    primary.logoUrl,
        allianceId:    entry.alliance_id,
        corporationId: entry.corporation_id,
        factionId:     entry.faction_id,
        alliance,
        corp,
        faction,
      });
    });

    return () => { cancelled = true; };
  }, [eveSystemId]);

  return sov;
}
