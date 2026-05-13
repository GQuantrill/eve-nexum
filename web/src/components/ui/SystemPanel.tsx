import { useEffect, useRef, useState } from 'react';
import { useSovData } from '../../hooks/useSovData';
import { useEsiSystem } from '../../hooks/useEsiSystem';
import { api } from '../../api/client';
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy, arrayMove } from '@dnd-kit/sortable';
import { useMapStore } from '../../store/mapStore';
import { CLASS_COLORS, CLASS_LABELS, EFFECT_LABELS, EFFECT_MODIFIERS, WORMHOLE_DESTINATIONS } from '../../data/wormholes';
import { DraggableCard } from './DraggableCard';
import { SignaturePane } from './SignaturePane';
import { StructuresPane } from './StructuresPane';
import { NpcStationsPane } from './NpcStationsPane';
import { NotesEditor } from './NotesEditor';
import { KillboardPane } from './KillboardPane';
import { ActivityPane } from './ActivityPane';
import { truesecColor } from '../../utils/truesec';
import { useIncursions, findIncursion } from '../../hooks/useIncursions';
import { useInsurgency, findInsurgency } from '../../hooks/useInsurgency';
import { useCanEdit } from '../../hooks/useCanEdit';

function FlashingSkull({ color }: { color: string }) {
  const [dim, setDim] = useState(false);
  useEffect(() => {
    const id = setInterval(() => setDim((v) => !v), 700);
    return () => clearInterval(id);
  }, []);
  return (
    <text x="27" y="31" textAnchor="middle" fontSize="14" fill={color} opacity={dim ? 0.15 : 1}>
      ☠
    </text>
  );
}

const PANEL_TITLES: Record<string, string> = {
  notes:       'Notes',
  signatures:  'Signatures',
  structures:  'Structures',
  npcStations: 'NPC Stations',
  killboard:   'zKillboard',
  activity:    'Activity',
};

const HEIGHT_KEY = 'nexum.panelHeight';
const MIN_H      = 80;
const DEFAULT_H  = 300;

function clamp(v: number) {
  return Math.min(Math.floor(window.innerHeight * 0.85), Math.max(MIN_H, v));
}


export function SystemPanel() {
  const systems          = useMapStore((s) => s.map.systems);
  const selectedSystemId = useMapStore((s) => s.selectedSystemId);
  const panelOrder       = useMapStore((s) => s.panelOrder);
  const updateSystem     = useMapStore((s) => s.updateSystem);
  const selectSystem     = useMapStore((s) => s.selectSystem);
  const setPanelOrder    = useMapStore((s) => s.setPanelOrder);
  const canEdit          = useCanEdit();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const [height, setHeight] = useState(() => {
    const v = localStorage.getItem(HEIGHT_KEY);
    return v ? clamp(parseInt(v, 10)) : DEFAULT_H;
  });
  const heightRef = useRef(height);

  const [waypointStatus, setWaypointStatus] = useState<'idle' | 'ok' | 'err'>('idle');

  const sys       = systems.find((s) => s.id === selectedSystemId);
  const sov       = useSovData(sys?.eveSystemId ?? null);
  const esiSys    = useEsiSystem(sys?.eveSystemId ?? null);
  const incursions   = useIncursions();
  const insurgencies = useInsurgency();
  if (!sys) return null;
  const incursion  = findIncursion(incursions, sys.eveSystemId);
  const insurgency = findInsurgency(insurgencies, sys.eveSystemId);

  const setWaypoint = (clearOtherWaypoints: boolean) => {
    if (!sys.eveSystemId) return;
    api('/api/character/waypoint', {
      method: 'POST',
      body: JSON.stringify({ destinationId: sys.eveSystemId, clearOtherWaypoints }),
    })
      .then(() => { setWaypointStatus('ok'); setTimeout(() => setWaypointStatus('idle'), 2000); })
      .catch(() => { setWaypointStatus('err'); setTimeout(() => setWaypointStatus('idle'), 2000); });
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const next = arrayMove(panelOrder, panelOrder.indexOf(String(active.id)), panelOrder.indexOf(String(over.id)));
    setPanelOrder(next);
  };

  const onResizeMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = heightRef.current;

    const onMove = (ev: MouseEvent) => {
      const next = clamp(startH + (startY - ev.clientY));
      heightRef.current = next;
      setHeight(next);
    };

    const onUp = () => {
      localStorage.setItem(HEIGHT_KEY, String(heightRef.current));
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  const cards: Record<string, React.ReactNode> = {
    notes: (
      <NotesEditor
        value={sys.notes}
        onChange={(v) => updateSystem(sys.id, { notes: v }, { skipUndo: true })}
        readOnly={!canEdit}
      />
    ),
    signatures:  <SignaturePane systemId={sys.id} />,
    structures:  <StructuresPane systemId={sys.id} />,
    npcStations: <NpcStationsPane eveSystemId={sys.eveSystemId} />,
    killboard:   <KillboardPane eveSystemId={sys.eveSystemId} />,
    activity:    <ActivityPane eveSystemId={sys.eveSystemId} />,
  };

  return (
    <aside className="system-panel" style={{ height }}>
      <div className="system-panel__resize-handle" onMouseDown={onResizeMouseDown} />

      <div className="system-panel__left">
        <div className="system-panel__header">
          <h2 className="system-panel__title">{sys.name || 'Unknown System'}</h2>
          <div className="system-panel__actions">
            {sys.eveSystemId && (
              <>
                <button
                  type="button"
                  className={`sys-btn${waypointStatus === 'ok' ? ' sys-btn--ok' : waypointStatus === 'err' ? ' sys-btn--err' : ''}`}
                  onClick={() => setWaypoint(true)}
                  title="Set Destination"
                >
                  Set Destination
                </button>
                <button
                  type="button"
                  className={`sys-btn${waypointStatus === 'ok' ? ' sys-btn--ok' : waypointStatus === 'err' ? ' sys-btn--err' : ''}`}
                  onClick={() => setWaypoint(false)}
                  title="Add Waypoint"
                >
                  + Waypoint
                </button>
              </>
            )}
            <button type="button" className="icon-btn" onClick={() => selectSystem(null)} title="Close">✕</button>
          </div>
        </div>

        <div className="sys-info">
          <div className="sys-info__headline">
            <span className="sys-info__badge" style={{ color: CLASS_COLORS[sys.systemClass] }}>
              {CLASS_LABELS[sys.systemClass]}
            </span>
            {esiSys?.securityStatus != null && (
              <span className="sys-info__truesec" style={{ color: truesecColor(esiSys.securityStatus) }}>
                {esiSys.securityStatus.toFixed(1)}
              </span>
            )}
            {sys.effect !== 'none' && (
              <span className="sys-info__effect">{EFFECT_LABELS[sys.effect]}</span>
            )}
          </div>

          {incursion && (
            <div className="sys-info__section sys-info__incursion">
              <div className="sys-info__section-label">Incursion</div>
              <div className="sys-info__incursion-card">
                {incursion.factionLogoUrl && (
                  <img className="sys-info__incursion-logo" src={incursion.factionLogoUrl} alt={incursion.factionName} />
                )}
                <div className="sys-info__incursion-detail">
                  <span className="sys-info__incursion-faction">{incursion.factionName}</span>
                  <div className="sys-info__incursion-meta">
                    <span className={`sys-info__incursion-state sys-info__incursion-state--${incursion.state}`}>
                      {incursion.state.charAt(0).toUpperCase() + incursion.state.slice(1)}
                    </span>
                    {incursion.isStaging && <span className="sys-info__incursion-staging">Staging</span>}
                    {incursion.hasBoss && <span className="sys-info__incursion-boss">Boss Present</span>}
                  </div>
                  <div className="sys-info__incursion-influence">
                    <div className="sys-info__incursion-bar-track">
                      <div className="sys-info__incursion-bar" style={{ width: `${Math.round(incursion.influence * 100)}%` }} />
                    </div>
                    <span className="sys-info__incursion-pct">{Math.round(incursion.influence * 100)}% influence</span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {insurgency && (
            <div className="sys-info__section">
              <div className="sys-info__section-label">Insurgency — {insurgency.factionName}</div>
              <div className="sys-info__insurgency-rings">
                {[
                  { label: 'Corruption',  pct: insurgency.corruptionPct,  stage: insurgency.corruptionState,  color: '#4ade80', icon: '☣' },
                  { label: 'Suppression', pct: insurgency.suppressionPct, stage: insurgency.suppressionState, color: '#c8d0e0', icon: '⊕' },
                ].map(({ label, pct, stage, color, icon }) => {
                  const R = 22;
                  const circ = 2 * Math.PI * R;
                  const fill = (pct / 100) * circ;
                  return (
                    <div key={label} className="sys-info__insurgency-ring-cell">
                      <svg className="sys-info__insurgency-svg" viewBox="0 0 54 54">
                        <circle cx="27" cy="27" r={R} fill="#0d1421" stroke="#1a2535" strokeWidth="4" />
                        <circle
                          cx="27" cy="27" r={R}
                          fill="none"
                          stroke={color}
                          strokeWidth="4"
                          strokeDasharray={`${fill} ${circ - fill}`}
                          strokeDashoffset={circ / 4}
                          strokeLinecap="round"
                          style={{ transition: 'stroke-dasharray 0.4s ease' }}
                        />
                        {icon === '☠' ? (
                          <FlashingSkull color={color} />
                        ) : (
                          <text x="27" y="31" textAnchor="middle" fontSize="14" fill={color}>
                            {icon}
                          </text>
                        )}
                      </svg>
                      <div className="sys-info__insurgency-ring-info">
                        <span className="sys-info__insurgency-ring-label">{label}</span>
                        <span className="sys-info__insurgency-ring-stage" style={{ color }}>Stage {stage}</span>
                        <span className="sys-info__insurgency-ring-pct">{Math.round(pct)}%</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {sys.effect !== 'none' && EFFECT_MODIFIERS[sys.effect].length > 0 && (
            <div className="sys-info__section">
              <div className="sys-info__section-label">System Effects</div>
              <div className="sys-info__effect-mods">
                {EFFECT_MODIFIERS[sys.effect].map(({ label, good }) => (
                  <span key={label} className={`sys-info__effect-mod${good ? ' sys-info__effect-mod--good' : ' sys-info__effect-mod--bad'}`}>
                    {good ? '▲' : '▼'} {label}
                  </span>
                ))}
              </div>
            </div>
          )}

          {sys.statics.length > 0 && (
            <div className="sys-info__section">
              <div className="sys-info__section-label">Statics</div>
              <div className="sys-info__row">
                {sys.statics.map((s) => {
                  const dest = WORMHOLE_DESTINATIONS[s];
                  return (
                    <span key={s} className="sys-info__static">
                      {s}
                      {dest && (
                        <span className="sys-info__static-dest" style={{ color: CLASS_COLORS[dest] }}>
                          {dest}
                        </span>
                      )}
                    </span>
                  );
                })}
              </div>
            </div>
          )}

          {(sys.regionName || sys.npcType) && (
            <div className="sys-info__section">
              <div className="sys-info__section-label">Location</div>
              <div className="sys-info__kv-grid">
                {sys.regionName    && <><span className="sys-info__kv-key">Region</span><span className="sys-info__kv-val">{sys.regionName}</span></>}
                {esiSys?.constellationName && <><span className="sys-info__kv-key">Constellation</span><span className="sys-info__kv-val">{esiSys.constellationName}</span></>}
                {sys.npcType       && <><span className="sys-info__kv-key">NPC</span><span className="sys-info__kv-val">{sys.npcType}</span></>}
              </div>
            </div>
          )}

          {esiSys && (esiSys.planetCount > 0 || esiSys.moonCount > 0 || esiSys.stargateCount > 0) && (
            <div className="sys-info__section">
              <div className="sys-info__section-label">Celestials</div>
              <div className="sys-info__celestials">
                {esiSys.planetCount > 0 && (
                  <div className="sys-info__celestial">
                    <span className="sys-info__celestial-icon">◎</span>
                    <span>{esiSys.planetCount}</span>
                    <span className="sys-info__celestial-label">planet{esiSys.planetCount !== 1 ? 's' : ''}</span>
                  </div>
                )}
                {esiSys.moonCount > 0 && (
                  <div className="sys-info__celestial">
                    <span className="sys-info__celestial-icon">○</span>
                    <span>{esiSys.moonCount}</span>
                    <span className="sys-info__celestial-label">moon{esiSys.moonCount !== 1 ? 's' : ''}</span>
                  </div>
                )}
                {esiSys.stargateCount > 0 && (
                  <div className="sys-info__celestial">
                    <span className="sys-info__celestial-icon">⬡</span>
                    <span>{esiSys.stargateCount}</span>
                    <span className="sys-info__celestial-label">gate{esiSys.stargateCount !== 1 ? 's' : ''}</span>
                  </div>
                )}
              </div>
            </div>
          )}

          {sov && (sov.alliance || sov.corp || sov.faction) && (
            <div className="sys-info__section">
              <div className="sys-info__section-label">Sovereignty</div>
            <div className="sys-info__sov-block">
              {sov.alliance && (
                <div className="sys-info__row sys-info__sov">
                  <img className="sys-info__sov-logo" src={sov.alliance.logoUrl} alt={sov.alliance.name} />
                  <div className="sys-info__sov-text">
                    <span className="sys-info__sov-label">Alliance</span>
                    <span className="sys-info__sov-name">{sov.alliance.name}</span>
                    <span className="sys-info__sov-ticker">[{sov.alliance.ticker}]</span>
                  </div>
                </div>
              )}
              {sov.corp && (
                <div className="sys-info__row sys-info__sov">
                  <img className="sys-info__sov-logo" src={sov.corp.logoUrl} alt={sov.corp.name} />
                  <div className="sys-info__sov-text">
                    <span className="sys-info__sov-label">Corp</span>
                    <span className="sys-info__sov-name">{sov.corp.name}</span>
                    <span className="sys-info__sov-ticker">[{sov.corp.ticker}]</span>
                  </div>
                </div>
              )}
              {sov.faction && (
                <div className="sys-info__row sys-info__sov">
                  <img className="sys-info__sov-logo" src={sov.faction.logoUrl} alt={sov.faction.name} />
                  <div className="sys-info__sov-text">
                    <span className="sys-info__sov-label">Faction</span>
                    <span className="sys-info__sov-name">{sov.faction.name}</span>
                  </div>
                </div>
              )}
            </div>
            </div>
          )}

        </div>
      </div>

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={panelOrder} strategy={verticalListSortingStrategy}>
          <div className="panel-stack">
            {panelOrder.map((id) => (
              <DraggableCard key={id} id={id} title={PANEL_TITLES[id] ?? id}>
                {cards[id]}
              </DraggableCard>
            ))}
          </div>
        </SortableContext>
      </DndContext>
    </aside>
  );
}
