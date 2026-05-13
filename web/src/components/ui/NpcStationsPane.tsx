import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { NpcStation } from '../../types';
import { ContextMenu } from './ContextMenu';
import { setDestination, addWaypoint } from '../../api/waypoint';
import { loadSystem } from '../../hooks/useEsiSystem';

const ESI = 'https://esi.evetech.net/latest';

const SERVICE_ICONS: Record<string, { icon: string; label: string }> = {
  'market':              { icon: '◈', label: 'Market' },
  'repair-facilities':   { icon: '⚙', label: 'Repair Facilities' },
  'fitting':             { icon: '⊕', label: 'Fitting' },
  'factory':             { icon: '⬡', label: 'Factory' },
  'labratory':           { icon: '⌬', label: 'Laboratory' },
  'reprocessing-plant':  { icon: '⟲', label: 'Reprocessing Plant' },
  'cloning':             { icon: '◑', label: 'Cloning' },
  'clones':              { icon: '◑', label: 'Clone Bay' },
  'insurance':           { icon: '◎', label: 'Insurance' },
  'loyalty-point-store': { icon: '✦', label: 'Loyalty Point Store' },
  'navy-offices':        { icon: '⚔', label: 'Navy Offices' },
  'security-offices':    { icon: '◉', label: 'Security Offices' },
  'bounty-missions':     { icon: '⊛', label: 'Bounty Missions' },
  'bounty-office':       { icon: '⊛', label: 'Bounty Office' },
  'assay-offices':       { icon: '⌖', label: 'Assay Office' },
  'office-rental':       { icon: '⊞', label: 'Office Rental' },
  'stock-exchange':      { icon: '⇅', label: 'Stock Exchange' },
  'commodity-trading':   { icon: '⇄', label: 'Commodity Trading' },
  'news':                { icon: '◫', label: 'News' },
  'docking':             { icon: '⬒', label: 'Docking' },
  'exploration':         { icon: '⟁', label: 'Exploration' },
  'black-market':        { icon: '◆', label: 'Black Market' },
  'mentoring':           { icon: '⊙', label: 'Mentoring' },
};

const stationCache = new Map<number, NpcStation[]>();

async function fetchStations(eveSystemId: number): Promise<NpcStation[]> {
  const cached = stationCache.get(eveSystemId);
  if (cached) return cached;

  const { stationIds } = await loadSystem(eveSystemId);
  if (stationIds.length === 0) {
    stationCache.set(eveSystemId, []);
    return [];
  }

  const stations = await Promise.all(
    stationIds.map(async (id) => {
      const r = await fetch(`${ESI}/universe/stations/${id}/`);
      if (!r.ok) return null;
      const d = await r.json() as { station_id: number; name: string; services?: string[] };
      return { id: d.station_id, name: d.name, services: d.services ?? [] } satisfies NpcStation;
    }),
  );
  const result = stations.filter((s): s is NpcStation => s !== null);
  stationCache.set(eveSystemId, result);
  return result;
}

interface CtxState { x: number; y: number; station: NpcStation }

export function NpcStationsPane({ eveSystemId }: { eveSystemId: number | null }) {
  const [stations, setStations] = useState<NpcStation[]>([]);
  const [loading, setLoading]   = useState(false);
  const [ctx, setCtx]           = useState<CtxState | null>(null);
  const ctxRef                  = useRef<CtxState | null>(null);
  ctxRef.current = ctx;

  useEffect(() => {
    if (!eveSystemId) return;
    setStations([]);
    setLoading(true);
    fetchStations(eveSystemId)
      .then(setStations)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [eveSystemId]);

  useEffect(() => {
    const close = () => setCtx(null);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, []);

  const onContextMenu = (e: React.MouseEvent, station: NpcStation) => {
    e.preventDefault();
    e.stopPropagation();
    setCtx({ x: e.clientX, y: e.clientY, station });
  };

  if (!eveSystemId) return <div className="sig-pane__empty">No EVE system linked</div>;
  if (loading)      return <div className="sig-pane__empty">Loading stations…</div>;
  if (stations.length === 0) return <div className="sig-pane__empty">No NPC stations in this system</div>;

  return (
    <>
      <ul className="npc-station-list">
        {stations.map((s) => (
          <li key={s.id} className="npc-station-item" onContextMenu={(e) => onContextMenu(e, s)}>
            <span className="npc-station-name">{s.name}</span>
            <span className="npc-station-actions">
              {s.services.length > 0 && (
                <span className="npc-station-services">
                  {s.services.map((svc) => {
                    const def = SERVICE_ICONS[svc];
                    if (!def) return null;
                    return (
                      <span key={svc} className="npc-svc-icon" data-tooltip={def.label}>
                        {def.icon}
                      </span>
                    );
                  })}
                </span>
              )}
              <span className="npc-station-btns">
                <button
                  type="button"
                  className="sys-btn"
                  onClick={(e) => { e.stopPropagation(); setDestination(s.id).catch(console.error); }}
                >
                  Set Destination
                </button>
                <button
                  type="button"
                  className="sys-btn"
                  onClick={(e) => { e.stopPropagation(); addWaypoint(s.id).catch(console.error); }}
                >
                  + Waypoint
                </button>
              </span>
            </span>
          </li>
        ))}
      </ul>

      {ctx && createPortal(
        <ContextMenu
          x={ctx.x}
          y={ctx.y}
          onClose={() => setCtx(null)}
          items={[
            {
              label: 'Set Destination',
              icon: '🎯',
              action: () => setDestination(ctx.station.id).catch(console.error),
            },
            {
              label: 'Add Waypoint',
              icon: '📍',
              action: () => addWaypoint(ctx.station.id).catch(console.error),
            },
          ]}
        />,
        document.body,
      )}
    </>
  );
}
