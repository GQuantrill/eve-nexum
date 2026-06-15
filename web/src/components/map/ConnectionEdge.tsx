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
  const conn = data as unknown as MapConnection & { edgeStyle?: string; connectionThickness?: 'thin' | 'standard' | 'thick' | 'extra' };
  const selectConnection = useMapStore((s) => s.selectConnection);
  const now = useNow30s();

  // Watchlist: a connection whose wormhole type (or frig-hole size) is on the
  // user's watchlist gets a coloured glow in the marker colour.
  const [watchEntries] = useWatchlist();
  const watch = conn ? matchConnection(watchEntries, conn) : null;
  const watchColor = watch ? watchMarker(watch.marker).color : null;

  const [edgePath, labelX, labelY] = (() => {
    const args = { sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition };
    switch (conn?.edgeStyle) {
      case 'straight':     return getStraightPath({ sourceX, sourceY, targetX, targetY });
      case 'smoothstep':   return getSmoothStepPath(args);
      default:             return getBezierPath(args);
    }
  })();

  const isJumpgate = conn?.connectionType === 'jumpgate';

  // Live EOL state takes priority over the legacy categorical timeStatus.
  const eolState   = !isJumpgate ? computeEolState(conn?.eolAt, now) : null;
  const timeStatus = conn?.timeStatus ?? null;

  const color = isJumpgate
    ? JUMPGATE_COLOR
    : (eolState?.color ?? TIME_COLORS[timeStatus ?? ''] ?? STANDARD_COLOR);
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
  const strokeWidth = selected ? baseWidth + 2 : baseWidth;
  const massLabel   = !isJumpgate && conn?.massStatus ? (MASS_LABELS[conn.massStatus] ?? null) : null;

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
          stroke: color,
          strokeWidth: watchColor ? strokeWidth + 1 : strokeWidth,
          strokeDasharray: isJumpgate ? '10 5' : undefined,
          filter: [
            selected ? `drop-shadow(0 0 6px ${color})` : null,
            watchColor ? `drop-shadow(0 0 5px ${watchColor}) drop-shadow(0 0 2px ${watchColor})` : null,
          ].filter(Boolean).join(' ') || undefined,
          opacity: selected || watchColor ? 1 : 0.85,
        }}
        markerEnd={undefined}
      />
      <EdgeLabelRenderer>
        {(() => {
          const typeNode = isJumpgate
            ? <span className="connection-label__jumpgate">JG</span>
            : conn?.type
              ? <span className="connection-label__type">{conn.type}</span>
              : null;
          const massNode = !isJumpgate && massLabel
            ? <span className={massLabel.cls}>{massLabel.text}</span>
            : null;
          const timeNode = timeLabel
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
