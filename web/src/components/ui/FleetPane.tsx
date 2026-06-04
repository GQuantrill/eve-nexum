import { useEffect, useMemo, useState } from 'react';
import { charPortrait } from '../../utils/eveImages';
import { useTranslation } from 'react-i18next';
import { ArrowUpIcon, ArrowDownIcon } from '@phosphor-icons/react';
import { useFleet } from '../../hooks/useFleet';
import { useRoute } from '../../hooks/useRoute';
import { useRouteOrigin } from '../../hooks/useRouteOrigin';
import { useUserSetting } from '../../hooks/useUserSetting';
import { useAuth } from '../../context/AuthContext';
import { jumps as jumpsLabel } from '../../i18n/format';

type SortBy  = 'distance' | 'name';
type SortDir = 'asc' | 'desc';

interface FleetRow { key: string; avatarId: number; name: string; location: string | null; jumps: number | null }

// Dev-only roster simulator: append ?fleetSim=N (capped at 255) in a dev build
// to populate the panel with N fake members for QA/screenshots. import.meta.env.DEV
// is false in production builds, so this is inert there. Avatars reuse the
// signed-in pilot's portrait so the rows look real; jumps/locations are spread
// (some w-space/unreachable) to exercise sorting.
function simRows(count: number, avatarId: number): FleetRow[] {
  return Array.from({ length: count }, (_, i) => {
    const unreachable = i % 11 === 0;
    return {
      key:      `sim-${i}`,
      avatarId,
      name:     `${String.fromCharCode(65 + (i * 7) % 26)} Sim Pilot ${i + 1}`,
      location: unreachable ? `J${100000 + (i * 7919) % 900000}` : `Sim System ${(i % 60) + 1}`,
      jumps:    unreachable ? null : (i * 7) % 42,
    };
  });
}

/**
 * Fleet roster panel. Lists every member of the signed-in pilot's fleet with
 * their current system and how many jumps away they are (from the active
 * route origin, honouring the route mode). Sortable by distance or name, asc
 * or desc. Fleets run up to 255 pilots, so the list scrolls rather than
 * expanding the sidebar. Empty when not in a fleet / no member visibility.
 */
export function FleetPane() {
  const { t } = useTranslation();
  const fleet  = useFleet();
  const origin = useRouteOrigin();
  const { user } = useAuth();
  const [sortBy,  setSortBy]  = useUserSetting<SortBy>('nexum.fleet.sortBy', 'distance');
  const [sortDir, setSortDir] = useUserSetting<SortDir>('nexum.fleet.sortDir', 'asc');

  // Dev-only simulator (see simRows). 0 in production builds.
  const simCount = useMemo(() => {
    if (!import.meta.env.DEV) return 0;
    const n = parseInt(new URLSearchParams(window.location.search).get('fleetSim') ?? '', 10);
    return Number.isFinite(n) && n > 0 ? Math.min(n, 255) : 0;
  }, []);

  // Filter box — debounced so we don't re-filter 255 rows on every keystroke.
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const id = setTimeout(() => setDebounced(query.trim().toLowerCase()), 200);
    return () => clearTimeout(id);
  }, [query]);

  // Jumps from the route origin to each member's system. w-space members have
  // no stargate route → no entry → jumps shown as "—" (location still shows).
  const memberSystemIds = useMemo(
    () => (simCount ? [] : fleet.members.map((m) => m.solarSystemId)),
    [simCount, fleet.members],
  );
  const routes = useRoute(origin.systemId, memberSystemIds);

  const rows = useMemo<FleetRow[]>(() => {
    const list: FleetRow[] = simCount
      ? simRows(simCount, user?.characterId ?? 1)
      : fleet.members.map((m) => {
          const route = routes[String(m.solarSystemId)];
          return {
            key:      `c${m.characterId}`,
            avatarId: m.characterId,
            name:     m.characterName ?? t('fleet.unknownPilot'),
            location: m.solarSystemName ?? route?.path?.[route.path.length - 1]?.name ?? null,
            jumps:    route ? route.jumps : null,
          };
        });
    const matched = debounced
      ? list.filter((r) => r.name.toLowerCase().includes(debounced)
                        || (r.location ?? '').toLowerCase().includes(debounced))
      : list;
    const dir = sortDir === 'asc' ? 1 : -1;
    matched.sort((a, b) => {
      if (sortBy === 'name') return dir * a.name.localeCompare(b.name);
      // distance: unknown/unreachable always sinks to the bottom, either way
      if (a.jumps == null && b.jumps == null) return a.name.localeCompare(b.name);
      if (a.jumps == null) return 1;
      if (b.jumps == null) return -1;
      return dir * (a.jumps - b.jumps) || a.name.localeCompare(b.name);
    });
    return matched;
  }, [simCount, user?.characterId, fleet.members, routes, sortBy, sortDir, debounced, t]);

  // Roster size before the search filter — distinguishes "no members" from
  // "no matches for the query" so the empty states don't lie.
  const total = simCount || fleet.members.length;
  if (!simCount && !fleet.inFleet) return <div className="scout-pane__empty">{t('fleet.notInFleet')}</div>;
  if (total === 0)                 return <div className="scout-pane__empty">{t('fleet.noMembers')}</div>;

  return (
    <div className="fleet-pane">
      <div className="fleet-pane__toolbar">
        <div className="fleet-pane__sortby">
          <button
            type="button"
            className={`fleet-pane__sort-btn${sortBy === 'distance' ? ' fleet-pane__sort-btn--on' : ''}`}
            onClick={() => setSortBy('distance')}
          >
            {t('fleet.sortDistance')}
          </button>
          <button
            type="button"
            className={`fleet-pane__sort-btn${sortBy === 'name' ? ' fleet-pane__sort-btn--on' : ''}`}
            onClick={() => setSortBy('name')}
          >
            {t('fleet.sortName')}
          </button>
        </div>
        <button
          type="button"
          className="fleet-pane__dir"
          onClick={() => setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))}
          data-tooltip={sortDir === 'asc' ? t('fleet.ascending') : t('fleet.descending')}
          aria-label={sortDir === 'asc' ? t('fleet.ascending') : t('fleet.descending')}
        >
          {sortDir === 'asc' ? <ArrowUpIcon size={13} weight="bold" /> : <ArrowDownIcon size={13} weight="bold" />}
        </button>
      </div>

      <input
        type="text"
        className="fleet-pane__search"
        placeholder={t('fleet.searchPlaceholder')}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        aria-label={t('fleet.searchPlaceholder')}
      />

      {rows.length === 0 ? (
        <div className="scout-pane__empty">{t('fleet.noMatches')}</div>
      ) : (
      <ul className="fleet-pane__list">
        {rows.map((r) => (
          <li key={r.key} className="fleet-pane__row">
            <img
              className="fleet-pane__avatar"
              src={charPortrait(r.avatarId, 32)}
              alt=""
              loading="lazy"
            />
            <span className="fleet-pane__name" title={r.name}>{r.name}</span>
            <span className="fleet-pane__loc" title={r.location ?? undefined}>
              {r.location ?? t('fleet.unknownLoc')}
            </span>
            <span className="fleet-pane__jumps">
              {r.jumps != null ? jumpsLabel(t, r.jumps) : '—'}
            </span>
          </li>
        ))}
      </ul>
      )}
    </div>
  );
}
