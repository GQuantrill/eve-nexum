import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
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
import { useStandings, type ContactKind } from '../../hooks/useStandings';
import { toast } from './Toaster';
import { truesecColor } from '../../utils/truesec';
import { useIncursions, findIncursion } from '../../hooks/useIncursions';
import { useInsurgency, findInsurgency } from '../../hooks/useInsurgency';
import { useCanEditContent } from '../../hooks/useCanEditContent';
import { useShareMode } from '../../context/ShareModeContext';
import { useCustomIntel } from '../../hooks/useCustomIntel';
import { resolveIntelColor, resolveIntelLabel } from '../../utils/intelColors';
import { WHTypeInfo } from './WHTypeInfo';
import { Tooltip } from './Tooltip';

/**
 * One chip in the "In chain:" digest. Owns its own hover state and renders
 * the modifier-list tooltip via portal so it can escape the system panel's
 * `overflow: hidden` and not get clipped.
 */
function ChainEffectChip({
  name, effect, isCurrent, onClick,
}: {
  name: string;
  effect: keyof typeof EFFECT_MODIFIERS;
  isCurrent: boolean;
  onClick: () => void;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  function onEnter() {
    if (!ref.current) return;
    const r = ref.current.getBoundingClientRect();
    setPos({ top: r.bottom + 6, left: r.left + r.width / 2 });
  }
  function onLeave() { setPos(null); }

  return (
    <>
      <span
        ref={ref}
        className={`sys-info__chain-fx__chip${isCurrent ? ' sys-info__chain-fx__chip--current' : ''}`}
        onMouseEnter={onEnter}
        onMouseLeave={onLeave}
        onClick={onClick}
      >
        {EFFECT_LABELS[effect]} <span className="sys-info__chain-fx__sys">({name})</span>
      </span>
      {pos && createPortal(
        <div
          className="sys-info__chain-fx__tip"
          style={{ top: pos.top, left: pos.left }}
        >
          {EFFECT_MODIFIERS[effect].map((m) => (
            <span
              key={m.label}
              className={m.good ? 'sys-info__chain-fx__tip-good' : 'sys-info__chain-fx__tip-bad'}
            >
              {m.good ? '▲' : '▼'} {m.label}
            </span>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}

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

// Classes for which a Dotlan #npc_delta map is meaningful. Wormhole and
// Drifter systems get no link — dotlan has those pages but no NPC data.
const DOTLAN_CLASSES = new Set(['HS', 'LS', 'NS', 'Thera', 'Pochven']);

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
  const canEdit          = useCanEditContent();
  const { isShareMode }  = useShareMode();
  // Per-category share-mode flags. Defaults are FALSE so a missing field
  // (older share payload, or a pre-flags map state) errs on hiding.
  const shareIncludesSigs       = useMapStore((s) => s.map.shareIncludeSigs       === true);
  const shareIncludesNotes      = useMapStore((s) => s.map.shareIncludeNotes      === true);
  const shareIncludesStructures = useMapStore((s) => s.map.shareIncludeStructures === true);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const [height, setHeight] = useState(() => {
    const v = localStorage.getItem(HEIGHT_KEY);
    return v ? clamp(parseInt(v, 10)) : DEFAULT_H;
  });
  const heightRef = useRef(height);

  const [waypointStatus, setWaypointStatus] = useState<'idle' | 'ok' | 'err'>('idle');

  const sys       = systems.find((s) => s.id === selectedSystemId);
  const sov       = useSovData(sys?.eveSystemId ?? null);
  const standings = useStandings();
  const esiSys    = useEsiSystem(sys?.eveSystemId ?? null);
  const incursions   = useIncursions();
  const insurgencies = useInsurgency();
  const [customIntel] = useCustomIntel();
  if (!sys) return null;
  const incursion  = findIncursion(incursions, sys.eveSystemId);
  const insurgency = findInsurgency(insurgencies, sys.eveSystemId);
  const intelColor = resolveIntelColor(sys.intel, customIntel);
  const intelLabel = resolveIntelLabel(sys.intel, customIntel);

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
        readOnly={!canEdit || isShareMode}
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
            {sys.eveSystemId && !isShareMode && (
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
            {/* Current intel tag — only rendered when the user has actually
                set one. Pulls colour + label from the same resolver used by
                the node border + right-click menu so all three stay in
                sync if the user edits a custom intel definition. */}
            {sys.intel && intelLabel && (
              <span className="sys-info__intel" style={{ borderColor: intelColor ?? '#445' }}>
                <span className="sys-info__intel-swatch" style={{ background: intelColor ?? '#445' }} />
                {intelLabel}
              </span>
            )}
          </div>

          {(() => {
            const chainEffects = systems.filter((s) => s.effect !== 'none');
            if (chainEffects.length === 0) return null;
            return (
              <div className="sys-info__chain-fx">
                <span className="sys-info__chain-fx__label">In chain:</span>
                {chainEffects.map((s) => (
                  <ChainEffectChip
                    key={s.id}
                    name={s.name}
                    effect={s.effect}
                    isCurrent={s.id === sys.id}
                    onClick={() => selectSystem(s.id)}
                  />
                ))}
              </div>
            );
          })()}

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
                    <WHTypeInfo key={s} code={s}>
                      <span className="sys-info__static">
                        {s}
                        {dest && (
                          <span className="sys-info__static-dest" style={{ color: CLASS_COLORS[dest] }}>
                            {dest}
                          </span>
                        )}
                      </span>
                    </WHTypeInfo>
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

          {(sys.name || sys.eveSystemId) && (
            <div className="sys-info__section">
              <div className="sys-info__section-label">Links</div>
              <div className="sys-info__links">
                {/* Dotlan only needs the name. K-space goes to the NPC-delta
                    map (uses Region + System); j-space and unlinked systems
                    fall back to the plain /system/<name> URL. */}
                {sys.name && DOTLAN_CLASSES.has(sys.systemClass) && sys.regionName && (
                  <Tooltip label="Open NPC delta on Dotlan" placement="right">
                    <a
                      href={`https://evemaps.dotlan.net/map/${encodeURIComponent(sys.regionName.replace(/ /g, '_'))}/${encodeURIComponent(sys.name.replace(/ /g, '_'))}#npc_delta`}
                      target="_blank"
                      rel="noreferrer"
                      className="sys-info__ext-link"
                    >
                      <img
                        src="/vendor/dotlan.ico"
                        alt="Dotlan"
                        className="sys-info__ext-icon"
                        loading="lazy"
                      />
                    </a>
                  </Tooltip>
                )}
                {sys.name && !(DOTLAN_CLASSES.has(sys.systemClass) && sys.regionName) && (
                  <Tooltip label="Open system on Dotlan" placement="right">
                    <a
                      href={`https://evemaps.dotlan.net/system/${encodeURIComponent(sys.name.replace(/ /g, '_'))}`}
                      target="_blank"
                      rel="noreferrer"
                      className="sys-info__ext-link"
                    >
                      <img
                        src="/vendor/dotlan.ico"
                        alt="Dotlan"
                        className="sys-info__ext-icon"
                        loading="lazy"
                      />
                    </a>
                  </Tooltip>
                )}
                {sys.eveSystemId && (
                  <Tooltip label="Open system on zKillboard" placement="right">
                    <a
                      href={`https://zkillboard.com/system/${sys.eveSystemId}/`}
                      target="_blank"
                      rel="noreferrer"
                      className="sys-info__ext-link"
                    >
                      <img
                        src="/vendor/zkillboard-wreck.png"
                        alt="zKillboard"
                        className="sys-info__ext-icon"
                        loading="lazy"
                      />
                    </a>
                  </Tooltip>
                )}
              </div>
            </div>
          )}

          {esiSys && (esiSys.planetCount > 0 || esiSys.moonCount > 0 || esiSys.beltCount > 0 || esiSys.stargateCount > 0) && (
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
                {esiSys.beltCount > 0 && (
                  <div className="sys-info__celestial">
                    <span className="sys-info__celestial-icon">⁂</span>
                    <span>{esiSys.beltCount}</span>
                    <span className="sys-info__celestial-label">belt{esiSys.beltCount !== 1 ? 's' : ''}</span>
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
              <div className="sys-info__section-label">
                Sovereignty
                <StandingsRefreshButton standings={standings} />
              </div>
            <div className="sys-info__sov-block">
              {sov.alliance && sov.allianceId !== undefined && (
                <div className="sys-info__row sys-info__sov">
                  <img className="sys-info__sov-logo" src={sov.alliance.logoUrl} alt={sov.alliance.name} />
                  <div className="sys-info__sov-text">
                    <span className="sys-info__sov-label">Alliance</span>
                    <span className="sys-info__sov-name">{sov.alliance.name}</span>
                    <span className="sys-info__sov-ticker">[{sov.alliance.ticker}]</span>
                  </div>
                  <StandingsBadges
                    standings={standings}
                    kind="alliance"
                    id={sov.allianceId}
                  />
                </div>
              )}
              {sov.corp && sov.corporationId !== undefined && (
                <div className="sys-info__row sys-info__sov">
                  <img className="sys-info__sov-logo" src={sov.corp.logoUrl} alt={sov.corp.name} />
                  <div className="sys-info__sov-text">
                    <span className="sys-info__sov-label">Corp</span>
                    <span className="sys-info__sov-name">{sov.corp.name}</span>
                    <span className="sys-info__sov-ticker">[{sov.corp.ticker}]</span>
                  </div>
                  <StandingsBadges
                    standings={standings}
                    kind="corporation"
                    id={sov.corporationId}
                  />
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
            {panelOrder
              // In share mode each panel category is gated on the
              // matching include-flag the owner picked at link time.
              // Anything off → hide the tab entirely so a guest never
              // sees an empty pane.
              .filter((id) => {
                if (!isShareMode) return true;
                if (id === 'notes')      return shareIncludesNotes;
                if (id === 'structures') return shareIncludesStructures;
                if (id === 'signatures') return shareIncludesSigs;
                return true;
              })
              .map((id) => (
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

// Tiny refresh button rendered next to the "Sovereignty" header. Calls
// the manual standings refresh endpoint, which re-pulls personal / corp /
// alliance contacts from ESI (bypassing the 6h server TTL) and then
// updates the in-memory cache so every consumer re-renders.
function StandingsRefreshButton({ standings }: { standings: ReturnType<typeof useStandings> }) {
  const [status, setStatus] = useState<'idle' | 'ok' | 'err'>('idle');
  const busy = standings.refreshing || status === 'idle' && false; // placeholder, see onClick

  async function onClick() {
    const r = await standings.refresh();
    if (!r) { setStatus('err'); }
    else if (r.succeeded?.character || r.succeeded?.corp || r.succeeded?.alliance) {
      toast.success(
        `Standings refreshed — ${r.counts?.character ?? 0} personal · ${r.counts?.corp ?? 0} corp · ${r.counts?.alliance ?? 0} alliance contacts`
      );
      setStatus('ok');
    } else {
      toast.error('No contacts could be refreshed. Token may be missing the read_contacts scope — log out and back in.');
      setStatus('err');
    }
    setTimeout(() => setStatus('idle'), 2000);
  }

  return (
    <Tooltip label="Refresh standings from ESI now (bypasses the 6h TTL)" placement="above">
      <button
        type="button"
        className={`sys-info__refresh-btn${standings.refreshing ? ' sys-info__refresh-btn--busy' : ''}${status === 'ok' ? ' sys-info__refresh-btn--ok' : ''}${status === 'err' ? ' sys-info__refresh-btn--err' : ''}`}
        onClick={onClick}
        disabled={standings.refreshing || busy}
      >
        ↻
      </button>
    </Tooltip>
  );
}

// Inline standings strip next to a sov holder row. Renders up to three
// compact pills — Personal / Corp / Alliance — only for buckets that
// actually have a contact for this entity. Colour-coded against in-game
// blue (≥5) / red (≤-5) thresholds with a softer tier inside that range.
function StandingsBadges({
  standings,
  kind,
  id,
}: {
  standings: ReturnType<typeof useStandings>;
  kind: ContactKind;
  id: number;
}) {
  // Always render the container so the row layout is stable. When the
  // standings call hasn't returned yet, show a single "…" pill instead of
  // disappearing — makes it obvious whether the issue is "no data" vs
  // "data not loaded yet" without opening the network tab.
  if (!standings.loaded) {
    return (
      <div className="sys-info__sov-standings">
        <span
          className="sys-info__sov-standing sys-info__sov-standing--none"
          data-tooltip="Standings not loaded yet. If this stays here, log out and back in to grant the read_contacts scopes."
        >
          <span className="sys-info__sov-standing-value">…</span>
        </span>
      </div>
    );
  }

  const lookup = standings.getStanding(kind, id);
  // Always show all three pills so the layout is consistent across rows.
  // Buckets the user isn't a member of (no corp / no alliance) just show
  // "—" with the "none" colour tier.
  const entries: Array<{ label: string; value: number | null; hasBucket: boolean }> = [
    { label: 'P', value: lookup.character, hasBucket: true },
    { label: 'C', value: lookup.corp,      hasBucket: !!standings.self?.corpId     },
    { label: 'A', value: lookup.alliance,  hasBucket: !!standings.self?.allianceId },
  ];
  return (
    <div className="sys-info__sov-standings">
      {entries.map((e) => {
        const cls = !e.hasBucket || e.value === null ? 'sys-info__sov-standing--none' : standingClass(e.value);
        const tooltip = !e.hasBucket
          ? `${labelFor(e.label)}: you are not in one`
          : e.value === null
            ? `${labelFor(e.label)}: no standing set`
            : `${labelFor(e.label)}: ${e.value.toFixed(1)}`;
        return (
          <span
            key={e.label}
            className={`sys-info__sov-standing ${cls}`}
            data-tooltip={tooltip}
          >
            <span className="sys-info__sov-standing-label">{e.label}</span>
            <span className="sys-info__sov-standing-value">
              {!e.hasBucket || e.value === null ? '—' : e.value.toFixed(1)}
            </span>
          </span>
        );
      })}
    </div>
  );
}

function labelFor(short: string): string {
  switch (short) {
    case 'P': return 'Personal';
    case 'C': return 'Corp';
    case 'A': return 'Alliance';
    default:  return short;
  }
}

// Mirrors EVE's in-game standings flag bands. -5 sits in the "bad" /
// orange band; only values *below* -5 (e.g. -6, -10) flip to the red
// "terrible" band. Same logic on the positive side: +5 is light-blue
// "good"; +10 (or anywhere above +5) is the dark-blue "excellent" tier.
function standingClass(value: number | null): string {
  if (value === null) return 'sys-info__sov-standing--none';
  if (value < -5)     return 'sys-info__sov-standing--hostile';   // -10 zone (red)
  if (value < 0)      return 'sys-info__sov-standing--bad';       // -5 zone (orange)
  if (value > 5)      return 'sys-info__sov-standing--friendly';  // +10 zone (dark blue)
  if (value > 0)      return 'sys-info__sov-standing--good';      // +5 zone (light blue)
  return 'sys-info__sov-standing--neutral';
}
