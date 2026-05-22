import { useUserSetting } from './useUserSetting';

export type MinimapPosition = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

const KEY     = 'nexum.minimap.position';
const DEFAULT: MinimapPosition = 'bottom-right';
const VALID   = new Set<MinimapPosition>(['top-left', 'top-right', 'bottom-left', 'bottom-right']);

/**
 * Where the React Flow minimap docks. Persisted cross-device via
 * useUserSetting. The MapCanvas reads the same value to position
 * the MiniMap and to flip the Controls cluster to the opposite
 * bottom corner when the minimap takes bottom-left.
 */
export function useMinimapPosition(): [MinimapPosition, (p: MinimapPosition) => void] {
  const [v, setV] = useUserSetting<MinimapPosition>(KEY, DEFAULT);
  return [
    VALID.has(v) ? v : DEFAULT,
    (p) => setV(VALID.has(p) ? p : DEFAULT),
  ];
}
