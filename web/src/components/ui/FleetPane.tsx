import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowUpIcon, ArrowDownIcon } from '@phosphor-icons/react';
import { useFleet } from '../../hooks/useFleet';
import { useRoute } from '../../hooks/useRoute';
import { useRouteOrigin } from '../../hooks/useRouteOrigin';
import { useUserSetting } from '../../hooks/useUserSetting';
import { jumps as jumpsLabel } from '../../i18n/format';

type SortBy  = 'distance' | 'name';
type SortDir = 'asc' | 'desc';

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
  const [sortBy,  setSortBy]  = useUserSetting<SortBy>('nexum.fleet.sortBy', 'distance');
  const [sortDir, setSortDir] = useUserSetting<SortDir>('nexum.fleet.sortDir', 'asc');

  // Jumps from the route origin to each member's system. w-space members have
  // no stargate route → no entry → jumps shown as "—" (location still shows).
  const memberSystemIds = useMemo(() => fleet.members.map((m) => m.solarSystemId), [fleet.members]);
  const routes = useRoute(origin.systemId, memberSystemIds);

  const rows = useMemo(() => {
    const list = fleet.members.map((m) => {
      const route = routes[String(m.solarSystemId)];
      return {
        characterId: m.characterId,
        name:        m.characterName ?? t('fleet.unknownPilot'),
        location:    m.solarSystemName ?? route?.path?.[route.path.length - 1]?.name ?? null,
        jumps:       route ? route.jumps : null,
      };
    });
    const dir = sortDir === 'asc' ? 1 : -1;
    list.sort((a, b) => {
      if (sortBy === 'name') return dir * a.name.localeCompare(b.name);
      // distance: unknown/unreachable always sinks to the bottom, either way
      if (a.jumps == null && b.jumps == null) return a.name.localeCompare(b.name);
      if (a.jumps == null) return 1;
      if (b.jumps == null) return -1;
      return dir * (a.jumps - b.jumps) || a.name.localeCompare(b.name);
    });
    return list;
  }, [fleet.members, routes, sortBy, sortDir, t]);

  if (!fleet.inFleet)   return <div className="scout-pane__empty">{t('fleet.notInFleet')}</div>;
  if (rows.length === 0) return <div className="scout-pane__empty">{t('fleet.noMembers')}</div>;

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

      <ul className="fleet-pane__list">
        {rows.map((r) => (
          <li key={r.characterId} className="fleet-pane__row">
            <img
              className="fleet-pane__avatar"
              src={`https://images.evetech.net/characters/${r.characterId}/portrait?size=32`}
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
    </div>
  );
}
