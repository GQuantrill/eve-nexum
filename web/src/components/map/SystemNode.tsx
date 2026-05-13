import { memo, useMemo } from 'react';
import { Handle, Position, useConnection } from '@xyflow/react';
import type { NodeProps } from '@xyflow/react';
import type { MapSystem } from '../../types';
import { CLASS_COLORS, CLASS_LABELS, EFFECT_ICONS, EFFECT_LABELS, EFFECT_MODIFIERS, WORMHOLE_DESTINATIONS } from '../../data/wormholes';
import { useMapStore } from '../../store/mapStore';
import { useSovData } from '../../hooks/useSovData';
import { useEsiSystem } from '../../hooks/useEsiSystem';
import { useIncursions, findIncursion } from '../../hooks/useIncursions';
import { useInsurgency, findInsurgency } from '../../hooks/useInsurgency';
import { useScoutConnections, findScoutConnections } from '../../hooks/useScoutConnections';
import { useA0Systems } from '../../hooks/useA0Systems';
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
  const esiSys          = useEsiSystem(sys.eveSystemId);
  const incursions      = useIncursions();
  const incursion       = findIncursion(incursions, sys.eveSystemId);
  const insurgencies    = useInsurgency();
  const insurgency      = findInsurgency(insurgencies, sys.eveSystemId);
  const scoutAll        = useScoutConnections();
  const scoutMatches    = findScoutConnections(scoutAll, sys.eveSystemId);
  const a0Systems       = useA0Systems();
  const a0Ids           = useMemo(() => new Set(a0Systems.map(s => s.id)), [a0Systems]);
  const isA0            = sys.eveSystemId !== null && a0Ids.has(sys.eveSystemId);
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
      className={`system-node${sys.locked ? ' nopan' : ''}${isTarget ? ' system-node--connect-target' : ''}`}
      style={{ '--class-color': color } as React.CSSProperties}
      data-selected={selected}
      data-status={sys.status}
      data-home={sys.isHome}
      data-current={isCurrent}
      onClick={() => selectSystem(sys.id)}
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
        <span className="system-node__class-badge">{CLASS_LABELS[sys.systemClass]}</span>
        {esiSys?.securityStatus != null && (
          <span className="system-node__truesec" style={{ color: truesecColor(esiSys.securityStatus) }}>
            {esiSys.securityStatus.toFixed(1)}
          </span>
        )}
        <div className="system-node__icons">
          {sys.locked && <span className="system-node__lock-icon">🔒</span>}
          {sys.isHome && <span className="system-node__home-icon">⌂</span>}
          {incursion && (
            <span className="system-node__incursion-icon">
              ⚠
              <span className="system-node__incursion-tooltip">Incursion System</span>
            </span>
          )}
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
          {isA0 && (
            <span className="system-node__a0-icon">
              ★
              <span className="system-node__a0-tooltip">A0 sun</span>
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

      <div className="system-node__name">
        {isCurrent && <span className="system-node__current-dot" />}
        {sys.name || 'Unknown'}
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
              <span key={s} className="system-node__static-tag">
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
            );
          })}
        </div>
      )}

      {!compactMode && sov?.logoUrl && (
        <div className="system-node__sov-logo-wrap">
          <img className="system-node__sov-logo" src={sov.logoUrl} alt={sov.controller} />
          <span className="system-node__sov-tooltip">
            {sov.controller}
            {sov.ticker && <span className="system-node__sov-tooltip__ticker">[{sov.ticker}]</span>}
          </span>
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
