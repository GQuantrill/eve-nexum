import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  getBezierPath, getStraightPath, getSmoothStepPath,
  EdgeLabelRenderer, BaseEdge,
} from '@xyflow/react';
import type { EdgeProps } from '@xyflow/react';
import type { MapConnection } from '../../types';
import { useMapStore } from '../../store/mapStore';
import { useNow30s } from '../../hooks/useNow30s';
import { useWatchlist } from '../../hooks/useWatchlist';
import { matchConnection } from '../../utils/watchMatch';
import { watchMarker } from '../../data/watchMarkers';

// CSS custom properties (resolved via the edge path's inline `style`) so the
// colour-vision palettes (--cv-conn-* in App.css) re-map connection colours.
const STANDARD_COLOR = 'var(--cv-conn-standard)';
const JUMPGATE_COLOR  = 'var(--cv-conn-jumpgate)';
const GATE_COLOR      = 'var(--cv-conn-gate)';
const HIGHLIGHT_COLOR = 'var(--cv-conn-highlight)';

// Perpendicular spacing between multiple connections that share the same pair
// of systems, so they fan apart instead of stacking on one line.
const PARALLEL_SEP = 18;

const EOL_LIFE_MS    = 4 * 60 * 60 * 1000;
const EOL_LESS_1H_MS = 60 * 60 * 1000;

const TIME_COLORS: Record<string, string> = {
  lessThan4h: 'var(--cv-conn-4h)',
  lessThan1h: 'var(--cv-conn-1h)',
  expired:    'var(--cv-conn-expired)',
};

const MASS_LABELS: Record<string, { text: string; cls: string }> = {
  stable:       { text: '> 50%', cls: 'connection-label__mass' },
  destabilized: { text: '< 50%', cls: 'connection-label__mass connection-label__mass--warn' },
  critical:     { text: '< 10%', cls: 'connection-label__mass connection-label__mass--crit' },
};

/**
 * Given the EOL timestamp, return the live display state. Counts down from
 * 4h at the time EOL was marked; flips to "< 1 hr" when 3h have elapsed;
 * marks expired after 4h.
 */
function computeEolState(eolAt: string | null | undefined, now: number) {
  if (!eolAt) return null;
  const elapsed   = now - new Date(eolAt).getTime();
  const remaining = EOL_LIFE_MS - elapsed;
  if (remaining <= 0) return { color: TIME_COLORS.expired, label: '!', cls: 'connection-label__crit', expired: true };
  const hours = Math.floor(remaining / 3_600_000);
  const mins  = Math.floor((remaining % 3_600_000) / 60_000);
  const label = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
  if (remaining < EOL_LESS_1H_MS) {
    return { color: TIME_COLORS.lessThan1h, label, cls: 'connection-label__eol', expired: false };
  }
  return   { color: TIME_COLORS.lessThan4h, label, cls: 'connection-label__eol', expired: false };
}

export const ConnectionEdge = memo(({
  id, sourceX, sourceY, targetX, targetY,
  sourcePosition, targetPosition, data, selected,
}: EdgeProps) => {
  const { t } = useTranslation();
  const conn = data as unknown as MapConnection & {
    edgeStyle?: string;
    connectionThickness?: 'thin' | 'standard' | 'thick' | 'extra';
    highlighted?: boolean;
    parallelIndex?: number;
    parallelCount?: number;
  };
  const selectConnection = useMapStore((s) => s.selectConnection);
  const now = useNow30s();

  // Lit because the hovered/selected system is one of its endpoints — these get
  // recoloured (not just glowed) so a system's links pop out of a tangle.
  const highlighted = !!conn?.highlighted;
  // Emphasised = clicked-selected OR highlighted: drives stroke width / glow.
  const emphasized = selected || highlighted;

  // Watchlist: a connection whose wormhole type (or frig-hole size) is on the
  // user's watchlist gets a coloured glow in the marker colour.
  const [watchEntries] = useWatchlist();
  const watch = conn ? matchConnection(watchEntries, conn) : null;
  const watchColor = watch ? watchMarker(watch.marker).color : null;

  let [edgePath, labelX, labelY] = (() => {
    const args = { sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition };
    switch (conn?.edgeStyle) {
      case 'straight':     return getStraightPath({ sourceX, sourceY, targetX, targetY });
      case 'smoothstep':   return getSmoothStepPath(args);
      default:             return getBezierPath(args);
    }
  })();

  // Multiple connections between the same two systems would otherwise draw on
  // top of each other. Bow each one perpendicular to the straight source->
  // target line by an index-based offset, symmetric around the centre, so they
  // fan apart. Style-agnostic: a single edge (the common case) is untouched.
  const parallelCount = conn?.parallelCount ?? 1;
  if (parallelCount > 1) {
    const idx    = conn?.parallelIndex ?? 0;
    const spread = (idx - (parallelCount - 1) / 2) * PARALLEL_SEP;
    if (spread !== 0) {
      const dx  = targetX - sourceX;
      const dy  = targetY - sourceY;
      const len = Math.hypot(dx, dy) || 1;
      const nx  = -dy / len; // perpendicular unit vector
      const ny  =  dx / len;
      const cx  = (sourceX + targetX) / 2 + nx * spread;
      const cy  = (sourceY + targetY) / 2 + ny * spread;
      edgePath = `M ${sourceX},${sourceY} Q ${cx},${cy} ${targetX},${targetY}`;
      // Quadratic-bezier midpoint (t=0.5) for the label.
      labelX = 0.25 * sourceX + 0.5 * cx + 0.25 * targetX;
      labelY = 0.25 * sourceY + 0.5 * cy + 0.25 * targetY;
    }
  }

  const isJumpgate = conn?.connectionType === 'jumpgate'; // player Ansiblex bridge
  const isGate     = conn?.connectionType === 'gate';     // in-game stargate
  // Stargates and Ansiblex bridges are permanent in-game infrastructure — no
  // wormhole lifetime or mass to track.
  const noLifetime = isJumpgate || isGate;
  // Quarantined: the backing wormhole sig was deleted (hole collapsed). Kept on
  // the map but rendered severed (dashed/red + a ✂ marker) so the chain is
  // still traceable but clearly no longer an active link.
  const broken = !!conn?.broken;

  // Live EOL state takes priority over the legacy categorical timeStatus.
  const eolState   = !noLifetime ? computeEolState(conn?.eolAt, now) : null;
  const timeStatus = conn?.timeStatus ?? null;

  const color = isJumpgate ? JUMPGATE_COLOR
    : isGate ? GATE_COLOR
    : (eolState?.color ?? TIME_COLORS[timeStatus ?? ''] ?? STANDARD_COLOR);
  // Final stroke: broken keeps severed-red; otherwise a highlighted link (its
  // system is hovered/selected) takes the highlight hue, else its own state colour.
  const strokeColor = broken
    ? 'var(--cv-conn-expired)'
    : highlighted ? HIGHLIGHT_COLOR : color;
  // Per-user thickness preference. Standard = the historical 4 / 6 pair;
  // other steps scale around that. Selected always renders 2px thicker
  // than unselected so the selection highlight stays visible at every
  // size. See MapSidebar's Connection Thickness dropdown.
  const baseWidth = (
    conn?.connectionThickness === 'thin'  ? 2 :
    conn?.connectionThickness === 'thick' ? 6 :
    conn?.connectionThickness === 'extra' ? 8 :
    4
  );
  const strokeWidth = emphasized ? baseWidth + 2 : baseWidth;
  const massLabel   = !noLifetime && conn?.massStatus ? (MASS_LABELS[conn.massStatus] ?? null) : null;

  // Prefer the live countdown label; fall back to the static category label
  // if a connection has a legacy timeStatus value but no eolAt.
  const timeLabel = (() => {
    if (eolState) return { text: eolState.label, cls: eolState.cls };
    switch (timeStatus) {
      case 'lessThan24h': return { text: t('mapEdge.lessThan24h'), cls: 'connection-label__eol' };
      case 'lessThan4h':  return { text: t('mapEdge.lessThan4h'),  cls: 'connection-label__eol' };
      case 'lessThan1h':  return { text: t('mapEdge.lessThan1h'),  cls: 'connection-label__eol' };
      case 'expired':     return { text: '!',        cls: 'connection-label__crit' };
      default:            return null;
    }
  })();

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        style={{
          // A hovered/selected system's links recolour to the highlight hue so
          // they stand out; broken links keep the severed-red so their state
          // stays readable even while highlighted.
          stroke: strokeColor,
          strokeWidth: watchColor ? strokeWidth + 1 : strokeWidth,
          strokeDasharray: broken ? '5 7' : isJumpgate ? '10 5' : undefined,
          filter: [
            emphasized ? `drop-shadow(0 0 6px ${strokeColor})` : null,
            watchColor ? `drop-shadow(0 0 5px ${watchColor}) drop-shadow(0 0 2px ${watchColor})` : null,
          ].filter(Boolean).join(' ') || undefined,
          opacity: broken ? 0.7 : emphasized || watchColor ? 1 : 0.85,
        }}
        markerEnd={undefined}
      />
      <EdgeLabelRenderer>
        {broken && (
          <div
            className="connection-break"
            title={t('mapEdge.broken')}
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)` }}
            onClick={() => selectConnection(id)}
          >
            &#9986;
          </div>
        )}
        {!broken && (() => {
          const typeNode = isJumpgate
            ? <span className="connection-label__jumpgate">JG</span>
            : isGate
              ? <span className="connection-label__gate">G</span>
              : conn?.type
                ? <span className="connection-label__type">{conn.type}</span>
                : null;
          const massNode = !noLifetime && massLabel
            ? <span className={massLabel.cls}>{massLabel.text}</span>
            : null;
          const timeNode = !noLifetime && timeLabel
            ? <span className={timeLabel.cls}>{timeLabel.text}</span>
            : null;
          const count = (typeNode ? 1 : 0) + (massNode ? 1 : 0) + (timeNode ? 1 : 0);

          return (
            <div
              className="connection-label"
              style={{ transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)` }}
              onClick={() => selectConnection(id)}
            >
              {count === 3 ? (
                <>
                  <div className="connection-label__row connection-label__row--top">{typeNode}</div>
                  <div className="connection-label__row">{massNode}{timeNode}</div>
                </>
              ) : count > 0 ? (
                <div className="connection-label__row">{typeNode}{massNode}{timeNode}</div>
              ) : null}
            </div>
          );
        })()}
      </EdgeLabelRenderer>
    </>
  );
});

ConnectionEdge.displayName = 'ConnectionEdge';
