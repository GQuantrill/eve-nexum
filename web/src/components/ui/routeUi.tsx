import { api } from '../../api/client';
import { toast } from './Toaster';
import { truesecColor } from '../../utils/truesec';
import type { RouteEntry } from '../../hooks/useRoute';

/** Fire ESI waypoint endpoint; surface success/failure via toast. */
export function setWaypoint(systemId: number, systemName: string, clear: boolean) {
  api('/api/character/waypoint', {
    method: 'POST',
    body:   JSON.stringify({ destinationId: systemId, clearOtherWaypoints: clear }),
  })
    .then(() => toast.success(clear ? `Destination set to ${systemName}` : `Waypoint added: ${systemName}`))
    .catch(() => toast.error('Failed to set waypoint — is your character online?'));
}

/** Wrap-friendly row of coloured squares, one per system on the path. */
export function RouteSquares({ route }: { route: RouteEntry }) {
  return (
    <div className="scout-route">
      {route.path.map((sys, i) => (
        <span
          key={`${sys.id}-${i}`}
          className="scout-route__square"
          style={{ background: truesecColor(sys.security) }}
          data-tooltip={`${sys.name} ${sys.security.toFixed(1)}`}
          aria-label={`${sys.name} ${sys.security.toFixed(1)}`}
        />
      ))}
    </div>
  );
}

/** K-space classes from which a stargate route can be computed. */
export const KSPACE_CLASSES = new Set(['HS', 'LS', 'NS', 'Pochven']);
