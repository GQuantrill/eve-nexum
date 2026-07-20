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
import { useWormholeTypes } from '../../hooks/useWormholeTypes';
import { matchConnection } from '../../utils/watchMatch';
import { watchMarker } from '../../data/watchMarkers';
import { effectiveExpiryMs, lifeBucket, type TimeBucket } from '../../utils/whLifetime';
import { hoursMins } from '../../i18n/format';
import type { TFunction } from 'i18next';

// CSS custom properties (resolved via the edge path's inline `style`) so the
// colour-vision palettes (--cv-conn-* in styles/tokens.css) re-map connection colours.
const STANDARD_COLOR = 'var(--cv-conn-standard)';
const JUMPGATE_COLOR  = 'var(--cv-conn-jumpgate)';
const GATE_COLOR      = 'var(--cv-conn-gate)';
const HIGHLIGHT_COLOR = 'var(--cv-conn-highlight)';

// Perpendicular spacing between multiple connections that share the same pair
// of systems, so they fan apart instead of stacking on one line.
const PARALLEL_SEP = 18;

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
 * Colour + label for a live time bucket. The two sub-4h buckets show a live
 * countdown (updated by useNow30s); "< 1 day" is a static band label; a fresh
 * hole (> 24h left) carries no time label. Returns null text ⇒ no label drawn.
 */
function bucketDisplay(
  bucket: TimeBucket, remainingMs: number, t: TFunction,
): { color: string; text: string | null; cls: string } {
  switch (bucket) {
    case 'expired':     return { color: TIME_COLORS.expired,    text: '!',                     cls: 'connection-label__crit' };
    case 'lessThan1h':  return { color: TIME_COLORS.lessThan1h, text: hoursMins(remainingMs),  cls: 'connection-label__eol' };
    case 'lessThan4h':  return { color: TIME_COLORS.lessThan4h, text: hoursMins(remainingMs),  cls: 'connection-label__eol' };
    case 'lessThan24h': return { color: STANDARD_COLOR,         text: t('mapEdge.lessThan24h'), cls: 'connection-label__eol' };
    default:            return { color: STANDARD_COLOR,         text: null,                    cls: '' };
  }
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
    dimmed?: boolean;
    parallelIndex?: number;
    parallelCount?: number;
  };
  const selectConnection = useMapStore((s) => s.selectConnection);
  const whTypes = useWormholeTypes();
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

  // Live lifetime: derive the current bucket from the hole's effective expiry
  // (manual override, legacy EOL mark, or createdAt + the wh type's max life),
  // re-evaluated every 30s via `now` so a hole visibly ages on its own. Null =
  // lifetime unknown (untyped / bare K162) → fall back to the stored category.
  const expiryMs   = !noLifetime && conn ? effectiveExpiryMs(conn, whTypes) : null;
  const lifeState  = expiryMs != null ? bucketDisplay(lifeBucket(expiryMs - now), expiryMs - now, t) : null;
  const timeStatus = conn?.timeStatus ?? null;

  const color = isJumpgate ? JUMPGATE_COLOR
    : isGate ? GATE_COLOR
    : (lifeState?.color ?? TIME_COLORS[timeStatus ?? ''] ?? STANDARD_COLOR);
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

  // Prefer the live bucket label; fall back to the stored category label only
  // for a connection whose lifetime is unknown but which carries a legacy
  // timeStatus value (e.g. a hand-set band on an untyped hole).
  const timeLabel = (() => {
    if (lifeState) return lifeState.text ? { text: lifeState.text, cls: lifeState.cls } : null;
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
          opacity: conn?.dimmed ? 0.1 : broken ? 0.7 : emphasized || watchColor ? 1 : 0.85,
        }}
        markerEnd={undefined}
      />
      <EdgeLabelRenderer>
        {broken && (
          <div
            className="connection-break"
            title={t('mapEdge.broken')}
            // Lift above a highlighted edge (zIndex 10) so the marker isn't
            // drawn under the hover-elevated line.
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`, zIndex: highlighted ? 1001 : undefined }}
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
                // Typeless wormhole normally shows no badge; surface a "WH" one
                // while hovered so every traced link reveals its jump type.
                : highlighted
                  ? <span className="connection-label__type">WH</span>
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
              // Lift above a highlighted edge (zIndex 10) — the edge-label
              // layer has no stacking context, so the label's own z-index wins
              // against the hover-elevated line and the badge stays readable.
              style={{ transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`, zIndex: highlighted ? 1001 : undefined }}
              onClick={() => selectConnection(id)}
            >
              {count > 0 ? (
                <>
                  {typeNode && <div className="connection-label__row">{typeNode}</div>}
                  {massNode && <div className="connection-label__row">{massNode}</div>}
                  {timeNode && <div className="connection-label__row">{timeNode}</div>}
                </>
              ) : null}
            </div>
          );
        })()}
      </EdgeLabelRenderer>
    </>
  );
});

ConnectionEdge.displayName = 'ConnectionEdge';
