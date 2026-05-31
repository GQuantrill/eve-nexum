import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';
import type { NpcStation } from '../../types';
import { ContextMenu } from './ContextMenu';
import { PathIcon, MapPinSimpleIcon } from '@phosphor-icons/react';
import { setDestination, addWaypoint } from '../../api/waypoint';
import { loadSystem } from '../../hooks/useEsiSystem';
import { useShareMode } from '../../context/ShareModeContext';

const ESI = 'https://esi.evetech.net/latest';

// `key` indexes into the npcStations.services.* i18n namespace; the union type
// keeps the dynamic t(`npcStations.services.${key}`) lookup type-checked.
type NpcServiceKey =
  | 'market' | 'repairFacilities' | 'fitting' | 'factory' | 'laboratory'
  | 'reprocessingPlant' | 'cloning' | 'cloneBay' | 'insurance' | 'loyaltyPointStore'
  | 'navyOffices' | 'securityOffices' | 'bountyMissions' | 'bountyOffice' | 'assayOffice'
  | 'officeRental' | 'stockExchange' | 'commodityTrading' | 'news' | 'docking'
  | 'exploration' | 'blackMarket' | 'mentoring';

const SERVICE_ICONS: Record<string, { icon: string; key: NpcServiceKey }> = {
  'market':              { icon: '◈', key: 'market' },
  'repair-facilities':   { icon: '⚙', key: 'repairFacilities' },
  'fitting':             { icon: '⊕', key: 'fitting' },
  'factory':             { icon: '⬡', key: 'factory' },
  'labratory':           { icon: '⌬', key: 'laboratory' },
  'reprocessing-plant':  { icon: '⟲', key: 'reprocessingPlant' },
  'cloning':             { icon: '◑', key: 'cloning' },
  'clones':              { icon: '◑', key: 'cloneBay' },
  'insurance':           { icon: '◎', key: 'insurance' },
  'loyalty-point-store': { icon: '✦', key: 'loyaltyPointStore' },
  'navy-offices':        { icon: '⚔', key: 'navyOffices' },
  'security-offices':    { icon: '◉', key: 'securityOffices' },
  'bounty-missions':     { icon: '⊛', key: 'bountyMissions' },
  'bounty-office':       { icon: '⊛', key: 'bountyOffice' },
  'assay-offices':       { icon: '⌖', key: 'assayOffice' },
  'office-rental':       { icon: '⊞', key: 'officeRental' },
  'stock-exchange':      { icon: '⇅', key: 'stockExchange' },
  'commodity-trading':   { icon: '⇄', key: 'commodityTrading' },
  'news':                { icon: '◫', key: 'news' },
  'docking':             { icon: '⬒', key: 'docking' },
  'exploration':         { icon: '⟁', key: 'exploration' },
  'black-market':        { icon: '◆', key: 'blackMarket' },
  'mentoring':           { icon: '⊙', key: 'mentoring' },
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
  const { t } = useTranslation();
  const [stations, setStations] = useState<NpcStation[]>([]);
  const [loading, setLoading]   = useState(false);
  const [ctx, setCtx]           = useState<CtxState | null>(null);
  const ctxRef                  = useRef<CtxState | null>(null);
  ctxRef.current = ctx;
  const { isShareMode } = useShareMode();

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

  if (!eveSystemId) return <div className="sig-pane__empty">{t('panes.noEveSystem')}</div>;
  if (loading)      return <div className="sig-pane__empty">{t('npcStations.loading')}</div>;
  if (stations.length === 0) return <div className="sig-pane__empty">{t('npcStations.none')}</div>;

  return (
    <>
      <ul className="npc-station-list">
        {stations.map((s) => (
          <li
            key={s.id}
            className="npc-station-item"
            onContextMenu={isShareMode ? undefined : (e) => onContextMenu(e, s)}
          >
            <span className="npc-station-name">{s.name}</span>
            <span className="npc-station-actions">
              {s.services.length > 0 && (
                <span className="npc-station-services">
                  {s.services.map((svc) => {
                    const def = SERVICE_ICONS[svc];
                    if (!def) return null;
                    return (
                      <span key={svc} className="npc-svc-icon" data-tooltip={t(`npcStations.services.${def.key}`)}>
                        {def.icon}
                      </span>
                    );
                  })}
                </span>
              )}
              {!isShareMode && (
                <span className="npc-station-btns">
                  <button
                    type="button"
                    className="sys-btn"
                    onClick={(e) => { e.stopPropagation(); setDestination(s.id).catch(console.error); }}
                  >
                    {t('waypoint.setDestination')}
                  </button>
                  <button
                    type="button"
                    className="sys-btn"
                    onClick={(e) => { e.stopPropagation(); addWaypoint(s.id).catch(console.error); }}
                  >
                    {t('systemPanel.addWaypointBtn')}
                  </button>
                </span>
              )}
            </span>
          </li>
        ))}
      </ul>

      {ctx && !isShareMode && createPortal(
        <ContextMenu
          x={ctx.x}
          y={ctx.y}
          onClose={() => setCtx(null)}
          items={[
            {
              label: t('waypoint.setDestination'),
              icon: <MapPinSimpleIcon size={16} weight="regular" color="#3ddc84" />,
              action: () => setDestination(ctx.station.id).catch(console.error),
            },
            {
              label: t('waypoint.addWaypoint'),
              icon: <PathIcon size={16} weight="regular" color="#5a9af8" />,
              action: () => addWaypoint(ctx.station.id).catch(console.error),
            },
          ]}
        />,
        document.body,
      )}
    </>
  );
}
