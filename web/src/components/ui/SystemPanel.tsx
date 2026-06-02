import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useSovData } from '../../hooks/useSovData';
import { useSystemInfo } from '../../hooks/useSystemInfo';
import { setDestination, addWaypoint } from '../../api/waypoint';
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


// Per-section collapse state for the system-info sections, persisted
// per-device (like the panel height) so a user's preferred layout sticks.
const COLLAPSE_PREFIX = 'nexum.sysinfo.collapse.';
function useSectionCollapse(id: string): [boolean, () => void] {
  const key = COLLAPSE_PREFIX + id;
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(key) === '1');
  const toggle = () => setCollapsed((c) => {
    const next = !c;
    localStorage.setItem(key, next ? '1' : '0');
    return next;
  });
  return [collapsed, toggle];
}

// A system-info section whose body collapses under a clickable label. The
// header stays visible (with a caret) so the section can be reopened; an
// optional `headerExtra` rides alongside the label (e.g. the sov refresh
// button).
function InfoSection({
  id, title, headerExtra, children,
}: {
  id: string;
  title: string;
  headerExtra?: React.ReactNode;
  children: React.ReactNode;
}) {
  const [collapsed, toggle] = useSectionCollapse(id);
  return (
    <div className="sys-info__section">
      <div className="sys-info__section-label">
        <button
          type="button"
          className="sys-info__section-toggle"
          onClick={toggle}
          aria-expanded={!collapsed}
        >
          <span className="sys-info__section-caret">{collapsed ? '▸' : '▾'}</span>
          {title}
        </button>
        {headerExtra}
      </div>
      {!collapsed && children}
    </div>
  );
}

const HEIGHT_KEY = 'nexum.panelHeight';
const WIDTH_KEY  = 'nexum.panelInfoWidth';
const COLLAPSE_KEY = 'nexum.panelInfoCollapsed';
const MIN_H      = 80;
const DEFAULT_H  = 300;
// System-info column width: the previous fixed 400px is the max; users can drag
// it narrower down to a still-readable minimum, and the panel-stack fills the
// space freed up (or the whole panel when the column is fully collapsed).
const MIN_W      = 280;
const MAX_W      = 400;
const DEFAULT_W  = 400;

function clampWidth(v: number) {
  return Math.min(MAX_W, Math.max(MIN_W, v));
}

// Classes for which a Dotlan #npc_delta map is meaningful. Wormhole and
// Drifter systems get no link — dotlan has those pages but no NPC data.
const DOTLAN_CLASSES = new Set(['HS', 'LS', 'NS', 'Thera', 'Pochven']);

function clamp(v: number) {
  return Math.min(Math.floor(window.innerHeight * 0.85), Math.max(MIN_H, v));
}


export function SystemPanel() {
  const { t } = useTranslation();
  const panelTitle: Record<string, string> = {
    notes:       t('panel.notes'),
    signatures:  t('panel.signatures'),
    structures:  t('panel.structures'),
    npcStations: t('panel.npcStations'),
    killboard:   t('panel.killboard'),
    activity:    t('panel.activity'),
  };
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

  const [infoWidth, setInfoWidth] = useState(() => {
    const v = localStorage.getItem(WIDTH_KEY);
    return v ? clampWidth(parseInt(v, 10)) : DEFAULT_W;
  });
  const infoWidthRef = useRef(infoWidth);

  const [infoCollapsed, setInfoCollapsed] = useState(() => localStorage.getItem(COLLAPSE_KEY) === '1');
  const toggleInfoCollapsed = () => setInfoCollapsed((c) => {
    const next = !c;
    localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0');
    return next;
  });

  const [waypointStatus, setWaypointStatus] = useState<'idle' | 'ok' | 'err'>('idle');

  const sys       = systems.find((s) => s.id === selectedSystemId);
  const sov       = useSovData(sys?.eveSystemId ?? null);
  const standings = useStandings();
  const esiSys    = useSystemInfo(sys?.eveSystemId ?? null);
  const incursions   = useIncursions();
  const insurgencies = useInsurgency();
  const [customIntel] = useCustomIntel();
  if (!sys) return null;
  const incursion  = findIncursion(incursions, sys.eveSystemId);
  const insurgency = findInsurgency(insurgencies, sys.eveSystemId);
  const intelColor = resolveIntelColor(sys.intel, customIntel);
  const intelLabel = resolveIntelLabel(sys.intel, customIntel, t);

  const setWaypoint = (clearOtherWaypoints: boolean) => {
    if (!sys.eveSystemId) return;
    // Shared helper toasts the outcome; we also flash the button state here.
    const req = clearOtherWaypoints
      ? setDestination(sys.eveSystemId, sys.name)
      : addWaypoint(sys.eveSystemId, sys.name);
    req
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

  // Horizontal drag on the divider between the system-info column and the
  // panel-stack: widen/narrow the info column (clamped MIN_W..MAX_W); the
  // stack flexes to fill whatever's left.
  const onColResizeMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = infoWidthRef.current;

    const onMove = (ev: MouseEvent) => {
      const next = clampWidth(startW + (ev.clientX - startX));
      infoWidthRef.current = next;
      setInfoWidth(next);
    };

    const onUp = () => {
      localStorage.setItem(WIDTH_KEY, String(infoWidthRef.current));
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

      {infoCollapsed ? (
        <button
          type="button"
          className="system-panel__expand"
          onClick={toggleInfoCollapsed}
          title={t('systemPanel.expandInfo')}
        >
          ›
        </button>
      ) : (
      <>
      <div className="system-panel__left" style={{ width: infoWidth }}>
        <div className="system-panel__header">
          <h2 className="system-panel__title">{sys.name || t('systemPanel.unknownSystem')}</h2>
          <div className="system-panel__actions">
            {sys.eveSystemId && !isShareMode && (
              <>
                <button
                  type="button"
                  className={`sys-btn${waypointStatus === 'ok' ? ' sys-btn--ok' : waypointStatus === 'err' ? ' sys-btn--err' : ''}`}
                  onClick={() => setWaypoint(true)}
                  title={t('waypoint.setDestination')}
                >
                  {t('waypoint.setDestination')}
                </button>
                <button
                  type="button"
                  className={`sys-btn${waypointStatus === 'ok' ? ' sys-btn--ok' : waypointStatus === 'err' ? ' sys-btn--err' : ''}`}
                  onClick={() => setWaypoint(false)}
                  title={t('waypoint.addWaypoint')}
                >
                  {t('systemPanel.addWaypointBtn')}
                </button>
              </>
            )}
            <button type="button" className="icon-btn" onClick={toggleInfoCollapsed} title={t('systemPanel.collapseInfo')}>‹</button>
            <button type="button" className="icon-btn" onClick={() => selectSystem(null)} title={t('actions.close')}>✕</button>
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
                <span className="sys-info__chain-fx__label">{t('systemPanel.inChain')}</span>
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
              <div className="sys-info__section-label">{t('systemPanel.incursion')}</div>
              <div className="sys-info__incursion-card">
                {incursion.factionLogoUrl && (
                  <img className="sys-info__incursion-logo" src={incursion.factionLogoUrl} alt={incursion.factionName} />
                )}
                <div className="sys-info__incursion-detail">
                  <span className="sys-info__incursion-faction">{incursion.factionName}</span>
                  <div className="sys-info__incursion-meta">
                    <span className={`sys-info__incursion-state sys-info__incursion-state--${incursion.state}`}>
                      {incursion.state === 'established' ? t('systemPanel.incursionState.established')
                        : incursion.state === 'mobilizing' ? t('systemPanel.incursionState.mobilizing')
                        : incursion.state === 'withdrawing' ? t('systemPanel.incursionState.withdrawing')
                        : incursion.state.charAt(0).toUpperCase() + incursion.state.slice(1)}
                    </span>
                    {incursion.isStaging && <span className="sys-info__incursion-staging">{t('systemPanel.staging')}</span>}
                    {incursion.hasBoss && <span className="sys-info__incursion-boss">{t('systemPanel.bossPresent')}</span>}
                  </div>
                  <div className="sys-info__incursion-influence">
                    <div className="sys-info__incursion-bar-track">
                      <div className="sys-info__incursion-bar" style={{ width: `${Math.round(incursion.influence * 100)}%` }} />
                    </div>
                    <span className="sys-info__incursion-pct">{t('systemPanel.influence', { pct: Math.round(incursion.influence * 100) })}</span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {insurgency && (
            <div className="sys-info__section">
              <div className="sys-info__section-label">{t('systemPanel.insurgency', { faction: insurgency.factionName })}</div>
              <div className="sys-info__insurgency-rings">
                {[
                  { label: t('systemPanel.corruption'),  pct: insurgency.corruptionPct,  stage: insurgency.corruptionState,  color: '#4ade80', icon: '☣' },
                  { label: t('systemPanel.suppression'), pct: insurgency.suppressionPct, stage: insurgency.suppressionState, color: '#c8d0e0', icon: '⊕' },
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
                        <span className="sys-info__insurgency-ring-stage" style={{ color }}>{t('systemPanel.stage', { stage })}</span>
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
              <div className="sys-info__section-label">{t('systemPanel.systemEffects')}</div>
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
              <div className="sys-info__section-label">{t('systemPanel.statics')}</div>
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

          {(sys.regionName || sys.npcType || esiSys?.constellationName) && (
            <InfoSection id="location" title={t('systemPanel.location')}>
              <div className="sys-info__kv-grid">
                {sys.regionName    && <><span className="sys-info__kv-key">{t('systemPanel.region')}</span><span className="sys-info__kv-val">{sys.regionName}</span></>}
                {esiSys?.constellationName && <><span className="sys-info__kv-key">{t('systemPanel.constellation')}</span><span className="sys-info__kv-val">{esiSys.constellationName}</span></>}
                {sys.npcType       && <><span className="sys-info__kv-key">{t('systemPanel.npc')}</span><span className="sys-info__kv-val">{sys.npcType}</span></>}
              </div>
            </InfoSection>
          )}

          {esiSys && (esiSys.sunType || esiSys.planetCount > 0 || esiSys.moonCount > 0 || esiSys.beltCount > 0 || esiSys.stargateCount > 0) && (
            <InfoSection id="celestials" title={t('systemPanel.celestials')}>
              {esiSys.sunType && (
                <div className="sys-info__sun" title={t('systemPanel.sunType')}>
                  <span className="sys-info__celestial-icon sys-info__celestial-icon--sun">☀</span>
                  <span>{esiSys.sunType}</span>
                </div>
              )}
              <div className="sys-info__celestials">
                {esiSys.planetCount > 0 && (
                  <div className="sys-info__celestial">
                    <span className="sys-info__celestial-icon">◎</span>
                    <span>{esiSys.planetCount}</span>
                    <span className="sys-info__celestial-label">{t('systemPanel.planets', { count: esiSys.planetCount })}</span>
                  </div>
                )}
                {esiSys.moonCount > 0 && (
                  <div className="sys-info__celestial">
                    <span className="sys-info__celestial-icon">○</span>
                    <span>{esiSys.moonCount}</span>
                    <span className="sys-info__celestial-label">{t('systemPanel.moons', { count: esiSys.moonCount })}</span>
                  </div>
                )}
                {esiSys.beltCount > 0 && (
                  <div className="sys-info__celestial">
                    <span className="sys-info__celestial-icon">⁂</span>
                    <span>{esiSys.beltCount}</span>
                    <span className="sys-info__celestial-label">{t('systemPanel.belts', { count: esiSys.beltCount })}</span>
                  </div>
                )}
                {esiSys.stargateCount > 0 && (
                  <div className="sys-info__celestial">
                    <span className="sys-info__celestial-icon">⬡</span>
                    <span>{esiSys.stargateCount}</span>
                    <span className="sys-info__celestial-label">{t('systemPanel.gates', { count: esiSys.stargateCount })}</span>
                  </div>
                )}
              </div>
            </InfoSection>
          )}

          {sov && (sov.alliance || sov.corp || sov.faction) && (
            <InfoSection
              id="sov"
              title={t('systemPanel.sovereignty')}
              headerExtra={<StandingsRefreshButton standings={standings} />}
            >
            <div className="sys-info__sov-block">
              {sov.alliance && sov.allianceId !== undefined && (
                <div className="sys-info__row sys-info__sov">
                  <img className="sys-info__sov-logo" src={sov.alliance.logoUrl} alt={sov.alliance.name} />
                  <div className="sys-info__sov-text">
                    <span className="sys-info__sov-label">{t('systemPanel.alliance')}</span>
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
                    <span className="sys-info__sov-label">{t('systemPanel.corp')}</span>
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
                    <span className="sys-info__sov-label">{t('systemPanel.faction')}</span>
                    <span className="sys-info__sov-name">{sov.faction.name}</span>
                  </div>
                </div>
              )}
            </div>
            </InfoSection>
          )}

          {(sys.name || sys.eveSystemId) && (
            <InfoSection id="links" title={t('systemPanel.links')}>
              <div className="sys-info__links">
                {/* Dotlan only needs the name. K-space goes to the NPC-delta
                    map (uses Region + System); j-space and unlinked systems
                    fall back to the plain /system/<name> URL. */}
                {sys.name && DOTLAN_CLASSES.has(sys.systemClass) && sys.regionName && (
                  <Tooltip label={t('systemPanel.openNpcDelta')} placement="right">
                    <a
                      href={`https://evemaps.dotlan.net/map/${encodeURIComponent(sys.regionName.replace(/ /g, '_'))}/${encodeURIComponent(sys.name.replace(/ /g, '_'))}#npc_delta`}
                      target="_blank"
                      rel="noreferrer"
                      className="sys-info__ext-link"
                    >
                      <img src="/vendor/dotlan.ico" alt="Dotlan" className="sys-info__ext-icon" loading="lazy" />
                    </a>
                  </Tooltip>
                )}
                {sys.name && !(DOTLAN_CLASSES.has(sys.systemClass) && sys.regionName) && (
                  <Tooltip label={t('systemPanel.openDotlan')} placement="right">
                    <a
                      href={`https://evemaps.dotlan.net/system/${encodeURIComponent(sys.name.replace(/ /g, '_'))}`}
                      target="_blank"
                      rel="noreferrer"
                      className="sys-info__ext-link"
                    >
                      <img src="/vendor/dotlan.ico" alt="Dotlan" className="sys-info__ext-icon" loading="lazy" />
                    </a>
                  </Tooltip>
                )}
                {sys.eveSystemId && (
                  <Tooltip label={t('systemPanel.openZkb')} placement="right">
                    <a
                      href={`https://zkillboard.com/system/${sys.eveSystemId}/`}
                      target="_blank"
                      rel="noreferrer"
                      className="sys-info__ext-link"
                    >
                      <img src="/vendor/zkillboard-wreck.png" alt="zKillboard" className="sys-info__ext-icon" loading="lazy" />
                    </a>
                  </Tooltip>
                )}
              </div>
            </InfoSection>
          )}

        </div>
      </div>
      <div
        className="system-panel__col-resize"
        onMouseDown={onColResizeMouseDown}
        title={t('systemPanel.resizeInfo')}
      />
      </>
      )}

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
                <DraggableCard key={id} id={id} title={panelTitle[id] ?? id}>
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
  const { t } = useTranslation();
  const [status, setStatus] = useState<'idle' | 'ok' | 'err'>('idle');
  const busy = standings.refreshing || status === 'idle' && false; // placeholder, see onClick

  async function onClick() {
    const r = await standings.refresh();
    if (!r) { setStatus('err'); }
    else if (r.succeeded?.character || r.succeeded?.corp || r.succeeded?.alliance) {
      toast.success(
        t('systemPanel.standingsRefreshed', {
          personal: r.counts?.character ?? 0,
          corp: r.counts?.corp ?? 0,
          alliance: r.counts?.alliance ?? 0,
        })
      );
      setStatus('ok');
    } else {
      toast.error(t('systemPanel.noContactsRefreshed'));
      setStatus('err');
    }
    setTimeout(() => setStatus('idle'), 2000);
  }

  return (
    <Tooltip label={t('systemPanel.refreshStandings')} placement="above">
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
  const { t } = useTranslation();
  // Always render the container so the row layout is stable. When the
  // standings call hasn't returned yet, show a single "…" pill instead of
  // disappearing — makes it obvious whether the issue is "no data" vs
  // "data not loaded yet" without opening the network tab.
  if (!standings.loaded) {
    return (
      <div className="sys-info__sov-standings">
        <span
          className="sys-info__sov-standing sys-info__sov-standing--none"
          data-tooltip={t('systemPanel.standingsNotLoaded')}
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
        const lbl = labelFor(t, e.label);
        const tooltip = !e.hasBucket
          ? t('systemPanel.standingNotInBucket', { label: lbl })
          : e.value === null
            ? t('systemPanel.standingNotSet', { label: lbl })
            : t('systemPanel.standingValue', { label: lbl, value: e.value.toFixed(1) });
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

function labelFor(t: TFunction, short: string): string {
  switch (short) {
    case 'P': return t('systemPanel.personal');
    case 'C': return t('systemPanel.corp');
    case 'A': return t('systemPanel.alliance');
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
