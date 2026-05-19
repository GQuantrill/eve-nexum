import { memo, useMemo } from 'react';
import { Handle, Position, useConnection } from '@xyflow/react';
import type { NodeProps } from '@xyflow/react';
import type { MapSystem } from '../../types';
import { CLASS_COLORS, CLASS_LABELS, EFFECT_ICONS, EFFECT_LABELS, EFFECT_MODIFIERS, WORMHOLE_DESTINATIONS } from '../../data/wormholes';
import { useMapStore } from '../../store/mapStore';
import { useSovData } from '../../hooks/useSovData';
import { useStandings } from '../../hooks/useStandings';
import { useEsiSystem } from '../../hooks/useEsiSystem';
import { useIncursions, findIncursion } from '../../hooks/useIncursions';
import { useInsurgency, findInsurgency } from '../../hooks/useInsurgency';
import { useStorms, findStorm } from '../../hooks/useStorms';
import { useScoutConnections, findScoutConnections } from '../../hooks/useScoutConnections';
import { useA0Systems } from '../../hooks/useA0Systems';
import { useCurrentHourKills } from '../../hooks/useCurrentHourKills';
import { useNow30s } from '../../hooks/useNow30s';
import { useStaleThreshold } from '../../hooks/useStaleThreshold';
import { WHTypeInfo } from '../ui/WHTypeInfo';
import { truesecColor } from '../../utils/truesec';

type SystemNodeData = MapSystem & { selected: boolean };

export const SystemNode = memo(({ data, selected }: NodeProps) => {
  const sys = data as unknown as SystemNodeData;
  const color = CLASS_COLORS[sys.systemClass];
  const selectSystem    = useMapStore((s) => s.selectSystem);
  const compactMode     = useMapStore((s) => s.compactMode);
  const easyConnect     = useMapStore((s) => s.easyConnect);
  const currentSystemId = useMapStore((s) => s.currentSystemId);
  const isCurrent       = sys.id === currentSystemId;
  const sov             = useSovData(sys.eveSystemId);
  const standings       = useStandings();
  const esiSys          = useEsiSystem(sys.eveSystemId);

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
  const incursions      = useIncursions();
  const incursion       = findIncursion(incursions, sys.eveSystemId);
  const insurgencies    = useInsurgency();
  const insurgency      = findInsurgency(insurgencies, sys.eveSystemId);
  const storms          = useStorms();
  const storm           = findStorm(storms, sys.eveSystemId);
  const scoutAll        = useScoutConnections();
  const scoutMatches    = findScoutConnections(scoutAll, sys.eveSystemId);
  const a0Systems       = useA0Systems();
  const a0Ids           = useMemo(() => new Set(a0Systems.map(s => s.id)), [a0Systems]);
  const isA0            = sys.eveSystemId !== null && a0Ids.has(sys.eveSystemId);
  const allKills        = useCurrentHourKills();
  const myKills         = sys.eveSystemId !== null ? allKills.get(sys.eveSystemId) : undefined;
  const hotKills        = !!myKills && myKills.shipKills + myKills.podKills > 0;
  const now             = useNow30s();
  const [staleHours]    = useStaleThreshold();
  const isStale         = !!sys.lastActivityAt &&
                          (now - new Date(sys.lastActivityAt).getTime()) > staleHours * 3_600_000;
  const connection      = useConnection();

  // Tooltip label: dedupe by scout system name (Thera / Turnur). Multiple
  // connections from the same scout are summarised, mixed scouts are listed.
  const scoutLabel = scoutMatches.length === 0
    ? ''
    : (() => {
        const names = Array.from(new Set(scoutMatches.map(c => c.outSystemName)));
        return names.length === 1
          ? `${names[0]} connection${scoutMatches.length > 1 ? 's' : ''}`
          : `${names.join(' & ')} connections`;
      })();
  const isTarget        = connection.inProgress && connection.fromNode?.id !== sys.id;

  return (
    <div
      className={`system-node${sys.locked ? ' nopan' : ''}${isTarget ? ' system-node--connect-target' : ''}${isStale ? ' system-node--stale' : ''}${isSovHostile ? ' system-node--sov-hostile' : ''}${isSovBlue ? ' system-node--sov-blue' : ''}`}
      style={{ '--class-color': color } as React.CSSProperties}
      data-selected={selected}
      data-status={sys.status}
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
        {sys.isHome && (
          <svg
            className="system-node__home-icon"
            viewBox="0 0 16 16"
            width="13"
            height="13"
            aria-label="Home system"
          >
            <path d="M8 2 L2 7 L2 14 L6 14 L6 10 L10 10 L10 14 L14 14 L14 7 Z" fill="currentColor" />
          </svg>
        )}
        <span className="system-node__name">{sys.name || 'Unknown'}</span>
        {esiSys?.securityStatus != null && (
          <span className="system-node__truesec" style={{ color: truesecColor(esiSys.securityStatus) }}>
            {esiSys.securityStatus.toFixed(1)}
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
              ⚔
              <span className="system-node__kill-tooltip">
                {myKills.shipKills} ship · {myKills.podKills} pod kills this hour
              </span>
            </span>
          )}
          {isA0 && (
            <span className="system-node__a0-icon">
              ★
              <span className="system-node__a0-tooltip">A0 sun</span>
            </span>
          )}
          {incursion && (
            <span className="system-node__incursion-icon">
              ⚠
              <span className="system-node__incursion-tooltip">Incursion System</span>
            </span>
          )}
          {storm && (
            <span className={`system-node__storm-icon system-node__storm-icon--${storm.stormType}`}>
              ⚡
              <span className="system-node__storm-tooltip">
                <span className="system-node__storm-tooltip__title">{storm.stormName} storm</span>
                <span>Last report: {storm.lastReport}</span>
                {storm.reportedBy && <span>By: {storm.reportedBy}</span>}
              </span>
            </span>
          )}
          {sys.locked && <span className="system-node__lock-icon">🔒</span>}
          {insurgency && (
            <span className="system-node__insurgency-icon">
              ☠
              <span className="system-node__insurgency-tooltip">Insurgency System</span>
            </span>
          )}
          {scoutMatches.length > 0 && (
            <span className="system-node__scout-icon">
              ✦
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

      {!compactMode && sys.statics.length > 0 && (
        <div className="system-node__statics">
          <div className="title">Statics</div>
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
            {incursion.isStaging ? 'Staging' : 'Incursion'}
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
            {insurgency.corruptionState > 0 ? 'Corrupted' : 'Suppressed'}
            <span className="system-node__insurgency-badge-tooltip">{insurgency.factionName}</span>
          </span>
        </div>
      )}

    </div>
  );
});

SystemNode.displayName = 'SystemNode';
