import { memo, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Handle, Position, useConnection } from '@xyflow/react';
import {
  HouseIcon, LockIcon, WarningIcon, SkullIcon, LightningIcon,
  SunIcon, SnowflakeIcon, SwordIcon, SparkleIcon,
} from '@phosphor-icons/react';
import type { NodeProps } from '@xyflow/react';
import type { MapSystem } from '../../types';
import { CLASS_COLORS, CLASS_LABELS, EFFECT_ICONS, EFFECT_LABELS, EFFECT_MODIFIERS, WORMHOLE_DESTINATIONS } from '../../data/wormholes';
import { useMapStore } from '../../store/mapStore';
import { usePresenceStore } from '../../store/presenceStore';
import { useAccountLocations } from '../../hooks/useAccountLocations';
import { useSovData } from '../../hooks/useSovData';
import { useStandings } from '../../hooks/useStandings';
import { useFleet } from '../../hooks/useFleet';
import { useAuth } from '../../context/AuthContext';
import { useUserSetting } from '../../hooks/useUserSetting';
import { useIncursions, findIncursion } from '../../hooks/useIncursions';
import { useInsurgency, findInsurgency } from '../../hooks/useInsurgency';
import { useStorms, findStorm } from '../../hooks/useStorms';
import { useScoutConnections, findScoutConnections } from '../../hooks/useScoutConnections';
import { useA0Systems } from '../../hooks/useA0Systems';
import { useIceBeltSystems, hasIceBelt } from '../../hooks/useIceBeltSystems';
import { useCurrentHourKills } from '../../hooks/useCurrentHourKills';
import { useNow30s } from '../../hooks/useNow30s';
import { useStaleThreshold } from '../../hooks/useStaleThreshold';
import { useCustomIntel } from '../../hooks/useCustomIntel';
import { resolveIntelColor, resolveIntelLabel } from '../../utils/intelColors';
import { useWatchIndex, matchWatch } from '../../hooks/useWatchlist';
import { watchMarker } from '../../data/watchMarkers';
import { useHeatmap } from '../../context/HeatmapContext';
import { heatValue, heatColor } from '../../utils/heatmap';
import { WHTypeInfo } from '../ui/WHTypeInfo';
import { truesecColor } from '../../utils/truesec';

type SystemNodeData = MapSystem & { selected: boolean };

export const SystemNode = memo(({ data, selected }: NodeProps) => {
  const { t } = useTranslation();
  const sys = data as unknown as SystemNodeData;
  const color = CLASS_COLORS[sys.systemClass];
  const selectSystem    = useMapStore((s) => s.selectSystem);
  const compactMode     = useMapStore((s) => s.compactMode);
  const uniformSize     = useMapStore((s) => s.uniformSize);
  const showStatics     = useMapStore((s) => s.showStatics);
  const uniformWidth    = useMapStore((s) => s.uniformWidth);
  const uniformHeight   = useMapStore((s) => s.uniformHeight);
  const reportNodeSize  = useMapStore((s) => s.reportNodeSize);
  const forgetNodeSize  = useMapStore((s) => s.forgetNodeSize);
  const easyConnect     = useMapStore((s) => s.easyConnect);
  const currentSystemId = useMapStore((s) => s.currentSystemId);
  const isCurrent       = sys.id === currentSystemId;
  const sov             = useSovData(sys.eveSystemId);
  const standings       = useStandings();
  const fleet                = useFleet();
  const { user }             = useAuth();
  const [showFleetMembers]   = useUserSetting<boolean>('nexum.fleet.showMembers', true);
  // Fleet members in this exact system, minus the logged-in user — the
  // green you-are-here dot already represents them, so a purple dot
  // alongside would just be noise. When the only member here is the user,
  // this list is empty and the dot is suppressed entirely.
  const fleetHere       = useMemo(() => {
    if (!showFleetMembers)      return undefined;
    if (sys.eveSystemId == null) return undefined;
    const all = fleet.bySystem.get(sys.eveSystemId);
    if (!all || all.length === 0) return undefined;
    const myId = user?.characterId;
    return myId ? all.filter((m) => m.characterId !== myId) : all;
  }, [showFleetMembers, fleet.bySystem, sys.eveSystemId, user?.characterId]);

  // The account's other characters (alts) located in this system — live when
  // online, else their last known position. The active character has its own
  // you-are-here dot, so it's excluded server-side.
  const accountLocations     = useAccountLocations();
  const [showAccountChars]   = useUserSetting<boolean>('nexum.account.showOnMap', true);
  const accountHere = useMemo(() => {
    if (!showAccountChars || sys.eveSystemId == null) return undefined;
    const here = accountLocations.bySystem.get(sys.eveSystemId);
    return here && here.length ? here : undefined;
  }, [showAccountChars, accountLocations.bySystem, sys.eveSystemId]);

  // Other people viewing this map who are currently in this system (presence).
  // Excludes self — the green you-are-here dot covers that.
  const presenceViewers = usePresenceStore((s) => s.viewers);
  const presenceHere    = useMemo(() => {
    if (sys.eveSystemId == null) return undefined;
    const myId = user?.characterId;
    const here = Object.values(presenceViewers).filter(
      (v) => v.eveSystemId === sys.eveSystemId && v.characterId !== myId,
    );
    return here.length ? here : undefined;
  }, [presenceViewers, sys.eveSystemId, user?.characterId]);

  // Halo around any sov-holder system based on the user's contact bands.
  // Threshold is just "negative or positive" rather than the strict ≤-5
  // EVE flag tier — most players set hostiles to exactly -5 (orange),
  // which we still want to highlight on the map.
  const sovEffective = useMemo(() => {
    if (!standings.loaded || !sov) return 0;
    const values: number[] = [];
    if (sov.corporationId) values.push(standings.getStanding('corporation', sov.corporationId).effective);
    if (sov.allianceId)    values.push(standings.getStanding('alliance',    sov.allianceId).effective);
    if (!values.length) return 0;
    // Pick the most extreme magnitude so a +10 alliance with a 0 corp
    // still flashes blue (and vice-versa for hostile).
    return values.reduce((a, b) => (Math.abs(a) >= Math.abs(b) ? a : b));
  }, [standings, sov]);
  const isSovHostile = sovEffective < 0;
  const isSovBlue    = sovEffective > 0;
  // Each of these scans a cluster-wide array; memoize per-node so the O(n)
  // find/filter only runs when the array or this system's id changes, not on
  // every (re-)render of every node.
  const incursions      = useIncursions();
  const incursion       = useMemo(() => findIncursion(incursions, sys.eveSystemId), [incursions, sys.eveSystemId]);
  const insurgencies    = useInsurgency();
  const insurgency      = useMemo(() => findInsurgency(insurgencies, sys.eveSystemId), [insurgencies, sys.eveSystemId]);
  const storms          = useStorms();
  const storm           = useMemo(() => findStorm(storms, sys.eveSystemId), [storms, sys.eveSystemId]);
  const scoutAll        = useScoutConnections();
  const scoutMatches    = useMemo(() => findScoutConnections(scoutAll, sys.eveSystemId), [scoutAll, sys.eveSystemId]);
  const a0Systems       = useA0Systems();
  const a0Ids           = useMemo(() => new Set(a0Systems.map(s => s.id)), [a0Systems]);
  const isA0            = sys.eveSystemId !== null && a0Ids.has(sys.eveSystemId);
  const iceBeltSystems  = useIceBeltSystems();
  const isIceBelt       = useMemo(() => hasIceBelt(iceBeltSystems, sys.eveSystemId), [iceBeltSystems, sys.eveSystemId]);
  const allKills        = useCurrentHourKills();
  const myKills         = sys.eveSystemId !== null ? allKills.get(sys.eveSystemId) : undefined;
  const hotKills        = !!myKills && myKills.shipKills + myKills.podKills > 0;

  // Active heatmap glow for this node — value for the selected metric,
  // normalised against the per-map max (from HeatmapContext). null = no glow
  // (heatmap off, or this system has no value for the metric).
  const heatmap = useHeatmap();
  const heat = useMemo(() => {
    const metric = heatmap.metric;
    if (metric === 'none' || heatmap.max <= 0) return null;
    const v = heatValue(metric, sys.eveSystemId, allKills, fleet, user?.characterId);
    if (v <= 0) return null;
    // Raw 0..1 share drives the colour (yellow→orange→red); the glow strength
    // is that share times the user intensity, so the busiest system on the map
    // is the reference point and the slider just brightens/dims the rest.
    const raw = Math.min(1, v / heatmap.max);
    return { glow: Math.min(1, raw * heatmap.intensity), color: heatColor(raw) };
  }, [heatmap.metric, heatmap.max, heatmap.intensity, sys.eveSystemId, allKills, fleet, user?.characterId]);
  const now             = useNow30s();
  const [staleHours]    = useStaleThreshold();
  const isStale         = !!sys.lastActivityAt &&
                          (now - new Date(sys.lastActivityAt).getTime()) > staleHours * 3_600_000;
  const connection      = useConnection();
  const [customIntel]   = useCustomIntel();
  const intelColor      = resolveIntelColor(sys.intel, customIntel);
  const intelLabel      = resolveIntelLabel(sys.intel, customIntel, t);
  // Personal watchlist: highlight + corner glyph when this system's name is on
  // the user's hunting list. Matched by name (case-insensitive).
  const watchIndex      = useWatchIndex();
  const watch           = matchWatch(watchIndex, sys.name);
  const watchDef        = watch ? watchMarker(watch.marker) : null;
  const watchTip        = watch ? (watch.note?.trim() || t(`watchMarker.${watch.marker}`)) : undefined;

  // Tooltip label: dedupe by scout system name (Thera / Turnur). Multiple
  // connections from the same scout are summarised, mixed scouts are listed.
  const scoutLabel = useMemo(() => {
    if (scoutMatches.length === 0) return '';
    const names = Array.from(new Set(scoutMatches.map(c => c.outSystemName)));
    return names.length === 1
      ? t('mapNode.scoutConnections', { name: names[0], count: scoutMatches.length })
      : t('mapNode.scoutConnectionsMulti', { names: names.join(' & ') });
  }, [scoutMatches, t]);
  const isTarget        = connection.inProgress && connection.fromNode?.id !== sys.id;

  // Measure the node so the map store can compute the largest natural
  // width/height across all visible nodes — that becomes the min size
  // applied to everyone when uniform mode is on.
  const nodeRef = useRef<HTMLDivElement | null>(null);
  // Systems with statics (WH chains) can be 6× taller than a K-space
  // node — exclude them from the height max so a single Drifter doesn't
  // force every node on the map to be hundreds of pixels tall. When the
  // user has hidden statics on the map, the WH nodes shrink to the same
  // shape as K-space nodes, so they re-enter the height computation.
  const countHeight = sys.statics.length === 0 || !showStatics;
  useEffect(() => {
    const el = nodeRef.current;
    if (!el) return;
    const obs = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      // Use the border-box (= offsetWidth/Height) so minWidth/minHeight
      // applied to *this* element actually engages. contentRect excludes
      // the node's 8–12px padding + 1.5px border, so reporting that
      // value back as the min would always be smaller than the rendered
      // size and the constraint would be a no-op.
      const bb = entry.borderBoxSize?.[0];
      const w = bb ? bb.inlineSize : el.offsetWidth;
      const h = bb ? bb.blockSize  : el.offsetHeight;
      reportNodeSize(sys.id, w, h, countHeight);
    });
    obs.observe(el);
    return () => { obs.disconnect(); forgetNodeSize(sys.id); };
  }, [sys.id, countHeight, reportNodeSize, forgetNodeSize]);

  return (
    <div
      ref={nodeRef}
      className={`system-node${sys.locked ? ' nopan' : ''}${isTarget ? ' system-node--connect-target' : ''}${isStale ? ' system-node--stale' : ''}${isSovHostile ? ' system-node--sov-hostile' : ''}${isSovBlue ? ' system-node--sov-blue' : ''}${uniformSize ? ' system-node--uniform' : ''}${compactMode ? ' system-node--compact' : ''}${watchDef ? ' system-node--watched' : ''}`}
      style={{
        '--class-color': color,
        ...(intelColor ? { '--intel-color': intelColor } : null),
        ...(watchDef ? { '--watch-color': watchDef.color } : null),
        ...(heat ? { '--heat': heat.glow, '--heat-color': heat.color } : null),
        ...(uniformSize && uniformWidth  > 0 ? { minWidth:  uniformWidth  } : null),
        ...(uniformSize && uniformHeight > 0 ? { minHeight: uniformHeight } : null),
      } as React.CSSProperties}
      data-selected={selected}
      data-heat={heat ? '' : undefined}
      data-status={sys.status}
      data-intel={sys.intel ?? undefined}
      data-home={sys.isHome}
      data-current={isCurrent}
      onClick={(e) => {
        // Skip our single-select on shift-click so ReactFlow's built-in
        // multi-select can add this node to the existing selection. Calling
        // selectSystem here would change selectedSystemId, which fires the
        // systems→nodes effect and wipes ReactFlow's selection state.
        if (e.shiftKey || e.ctrlKey || e.metaKey) return;
        selectSystem(sys.id);
      }}
    >
      {/* Always present so existing edge handle references stay valid across mode toggles */}
      <Handle type="source" position={Position.Top}    id="top"    className={easyConnect ? 'system-handle system-handle--ghost' : 'system-handle'} />
      <Handle type="source" position={Position.Right}  id="right"  className={easyConnect ? 'system-handle system-handle--ghost' : 'system-handle'} />
      <Handle type="source" position={Position.Bottom} id="bottom" className={easyConnect ? 'system-handle system-handle--ghost' : 'system-handle'} />
      <Handle type="source" position={Position.Left}   id="left"   className={easyConnect ? 'system-handle system-handle--ghost' : 'system-handle'} />

      {/* Top-right intel marker. Real element (not a ::after) so it can carry
          a tooltip showing the intel label on hover. */}
      {sys.intel && (
        <span
          className="system-node__intel-corner"
          data-tooltip={intelLabel ?? undefined}
          aria-label={intelLabel ?? undefined}
        />
      )}

      {/* Top-left watchlist marker — the glyph for the marker kind, with the
          entry's note (or marker name) as the tooltip. */}
      {watchDef && (
        <span
          className="system-node__watch-corner"
          data-tooltip={watchTip}
          aria-label={watchTip}
        >
          {watchDef.glyph}
        </span>
      )}

      {easyConnect && (
        <>
          {/* Full-node source handle — drag from anywhere on the node to start a connection */}
          <Handle type="source" position={Position.Right} id="easy-source" className="system-node__easy-handle" />
          {/* Full-node target handle — isConnectableStart=false so it only receives, not starts */}
          <Handle type="target" position={Position.Left}  id="easy-target" className="system-node__easy-handle" isConnectableStart={false} />
          {/* Separate drag grip so nodes can still be moved */}
          <div className="system-node__drag-handle drag-handle" />
        </>
      )}

      <div className="system-node__header">
        {isCurrent && <span className="system-node__current-dot" />}
        {fleetHere && fleetHere.length > 0 && (
          <span className="system-node__fleet-dot-wrap">
            <span className="system-node__fleet-count">{fleetHere.length}</span>
            <span className="system-node__fleet-tooltip">
              {fleetHere.map((m) => (
                <span key={m.characterId} className="system-node__fleet-tooltip-row">
                  {m.characterName ?? t('mapNode.characterFallback', { id: m.characterId })}
                </span>
              ))}
            </span>
          </span>
        )}
        {accountHere && (
          <span className="system-node__alt-dot-wrap">
            <span className="system-node__alt-count">{accountHere.length}</span>
            <span className="system-node__alt-tooltip">
              {accountHere.map((c) => (
                <span key={c.charId} className="system-node__alt-tooltip-row">
                  {c.characterName}
                  {!c.online && <span className="system-node__alt-offline">{t('mapNode.altLastKnown')}</span>}
                </span>
              ))}
            </span>
          </span>
        )}
        {presenceHere && (
          <span className="system-node__presence-dot-wrap">
            <span className="system-node__presence-dot" />
            <span className="system-node__presence-tooltip">
              {presenceHere.map((v) => (
                <span key={v.characterId} className="system-node__presence-tooltip-row">
                  {v.characterName || t('mapNode.characterFallback', { id: v.characterId })}
                </span>
              ))}
            </span>
          </span>
        )}
        {sys.isHome && (
          <span className="system-node__home-icon" aria-label={t('mapNode.homeSystem')}>
            <HouseIcon size={14} weight="regular" />
          </span>
        )}
        <span className="system-node__name">{sys.name || t('mapNode.unknown')}</span>
        {sys.security != null && Number.isFinite(Number(sys.security)) && (
          <span className="system-node__truesec" style={{ color: truesecColor(Number(sys.security)) }}>
            {Number(sys.security).toFixed(1)}
          </span>
        )}
        {sov?.logoUrl && (
          <div className="system-node__sov-logo-wrap">
            <img className="system-node__sov-logo" src={sov.logoUrl} alt={sov.controller} />
            <span className="system-node__sov-tooltip">
              {sov.controller}
              {sov.ticker && <span className="system-node__sov-tooltip__ticker">[{sov.ticker}]</span>}
            </span>
          </div>
        )}
      </div>

      <div className="system-node__meta-row">
        <span className="system-node__class-badge">{CLASS_LABELS[sys.systemClass]}</span>
        <div className="system-node__icons">
          {hotKills && myKills && (
            <span className="system-node__kill-icon">
              <SwordIcon size={14} weight="regular" />
              <span className="system-node__kill-tooltip">
                {t('mapNode.killsTooltip', { ships: myKills.shipKills, pods: myKills.podKills })}
              </span>
            </span>
          )}
          {isA0 && (
            <span className="system-node__a0-icon">
              <SunIcon size={14} weight="regular" />
              <span className="system-node__a0-tooltip">{t('mapNode.a0Sun')}</span>
            </span>
          )}
          {isIceBelt && (
            <span className="system-node__ice-icon">
              <SnowflakeIcon size={14} weight="regular" />
              <span className="system-node__ice-tooltip">{t('mapNode.iceBelt')}</span>
            </span>
          )}
          {incursion && (
            <span className="system-node__incursion-icon">
              <WarningIcon size={14} weight="regular" />
              <span className="system-node__incursion-tooltip">{t('mapNode.incursion')}</span>
            </span>
          )}
          {storm && (
            <span className={`system-node__storm-icon system-node__storm-icon--${storm.stormType}`}>
              <LightningIcon size={14} weight="regular" />
              <span className="system-node__storm-tooltip">
                <span className="system-node__storm-tooltip__title">{t('mapNode.stormTitle', { name: storm.stormName })}</span>
                <span>{t('mapNode.stormLastReport', { value: storm.lastReport })}</span>
                {storm.reportedBy && <span>{t('mapNode.stormReportedBy', { value: storm.reportedBy })}</span>}
              </span>
            </span>
          )}
          {sys.locked && (
            <span className="system-node__lock-icon">
              <LockIcon size={14} weight="regular" />
            </span>
          )}
          {insurgency && (
            <span className="system-node__insurgency-icon">
              <SkullIcon size={14} weight="regular" />
              <span className="system-node__insurgency-tooltip">{t('mapNode.insurgency')}</span>
            </span>
          )}
          {scoutMatches.length > 0 && (
            <span className="system-node__scout-icon">
              <SparkleIcon size={14} weight="regular" />
              <span className="system-node__scout-tooltip">{scoutLabel}</span>
            </span>
          )}
          {sys.effect !== 'none' && (
            <span
              className="system-node__effect-icon"
              style={{ color: EFFECT_ICONS[sys.effect].color }}
            >
              {EFFECT_ICONS[sys.effect].symbol}
              <span className="system-node__effect-tooltip">
                <span className="system-node__effect-tooltip__title">{EFFECT_LABELS[sys.effect]}</span>
                {EFFECT_MODIFIERS[sys.effect].map(({ label, good }) => (
                  <span key={label} className={good ? 'system-node__effect-tooltip__good' : 'system-node__effect-tooltip__bad'}>
                    {good ? '▲' : '▼'} {label}
                  </span>
                ))}
              </span>
            </span>
          )}
        </div>
      </div>

      {!compactMode && sys.regionName && (
        <div className="system-node__npc-type">
          {sys.regionName}{sys.npcType ? ` - ${sys.npcType}` : ''}
        </div>
      )}

      {!compactMode && showStatics && sys.statics.length > 0 && (
        <div className="system-node__statics">
          <div className="title">{t('mapNode.statics')}</div>
          {sys.statics.map((s) => {
            const dest = WORMHOLE_DESTINATIONS[s];
            return (
              <WHTypeInfo key={s} code={s}>
              <span className="system-node__static-tag">
                {s}
                {dest && (
                  <span
                    className="system-node__static-dest"
                    style={{ color: CLASS_COLORS[dest] }}
                  >
                    {dest}
                  </span>
                )}
              </span>
              </WHTypeInfo>
            );
          })}
        </div>
      )}

      {!compactMode && incursion && (
        <div className="system-node__incursion-badge">
          {incursion.factionLogoUrl && (
            <img className="system-node__incursion-logo" src={incursion.factionLogoUrl} alt={incursion.factionName} />
          )}
          <span className="system-node__incursion-label">
            {incursion.isStaging ? t('mapNode.staging') : t('mapNode.incursionBadge')}
            <span className="system-node__incursion-badge-tooltip">{incursion.factionName}</span>
          </span>
        </div>
      )}

      {!compactMode && insurgency && (
        <div className="system-node__insurgency-badge">
          {insurgency.factionLogoUrl && (
            <img className="system-node__insurgency-logo" src={insurgency.factionLogoUrl} alt={insurgency.factionName} />
          )}
          <span className="system-node__insurgency-label">
            {insurgency.corruptionState > 0 ? t('mapNode.corrupted') : t('mapNode.suppressed')}
            <span className="system-node__insurgency-badge-tooltip">{insurgency.factionName}</span>
          </span>
        </div>
      )}

    </div>
  );
});

SystemNode.displayName = 'SystemNode';
