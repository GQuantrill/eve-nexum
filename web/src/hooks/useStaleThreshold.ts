import { useUserSetting } from './useUserSetting';

const KEY = 'nexum.staleThresholdH';
// 30 days × 24 hours — chains move fast in some wormholes, slow in others,
// so a month covers most "is this still relevant?" cases without forcing
// users to bump it on first use.
const DEFAULT_H = 24 * 30;

// 0 is the "Never fade" sentinel — a valid stored value that consumers read as
// "no system is ever stale". Any other value is an hours threshold (>= 1).
export const STALE_NEVER = 0;

export function useStaleThreshold(): [number, (h: number) => void] {
  const [v, setV] = useUserSetting<number>(KEY, DEFAULT_H);
  // Clamp on read/write. Legacy localStorage values that came through as
  // `'720'` parse to number 720 fine; brand-new users get DEFAULT_H. 0 passes
  // through as the "Never" sentinel; anything else is floored to >= 1 hour.
  return [
    Number.isFinite(v) && v >= 0 ? v : DEFAULT_H,
    (h: number) => setV(h <= 0 ? STALE_NEVER : Math.max(1, Math.floor(h))),
  ];
}
