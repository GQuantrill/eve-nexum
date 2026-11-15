import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { XIcon } from '../../icons';
import { useEsiSearch, systemResultLabel } from '../../hooks/useEsiSearch';
import { useUserSetting } from '../../hooks/useUserSetting';
import { useSearchKeys } from '../../hooks/useSearchKeys';
import { ROUTE_AVOID_KEY, type AvoidedSystem } from '../../hooks/useRoute';

const KSPACE = new Set(['HS', 'LS', 'NS']);
// Matches the server's cap on the avoid list it accepts per route request.
const MAX_AVOID = 200;

// The route avoidance list: k-space systems no route of ours passes through
// (Ahbazon, Uedama, ...). Synced with the other route settings. The results
// list sits in the flow rather than floating, so the sidebar's own scroll
// can't clip it.
export function RouteAvoidList() {
  const { t } = useTranslation();
  const [stored, setAvoided] = useUserSetting<AvoidedSystem[]>(ROUTE_AVOID_KEY, []);
  const avoided = Array.isArray(stored) ? stored : [];
  const [query, setQuery] = useState('');
  const { results, loading } = useEsiSearch(query);
  const matches = results.filter((r) => KSPACE.has(r.systemClass) && !avoided.some((a) => a.id === r.id));
  const show = query.trim().length >= 2 && (matches.length > 0 || loading);
  const full = avoided.length >= MAX_AVOID;

  const add = (s: AvoidedSystem) => {
    if (full || avoided.some((a) => a.id === s.id)) return;
    setAvoided([...avoided, s].sort((a, b) => a.name.localeCompare(b.name)));
    setQuery('');
  };
  const keys = useSearchKeys(matches, query, (r) => r.name, (r) => add({ id: r.id, name: r.name }));

  return (
    <div className="route-avoid">
      <div className="map-sidebar__label">{t('mapSidebar.routeAvoid')}</div>
      <input
        className="map-shares__input"
        type="text"
        value={query}
        disabled={full}
        placeholder={t('mapSidebar.routeAvoidAdd')}
        aria-label={t('mapSidebar.routeAvoidAdd')}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={keys.onKeyDown}
      />
      {show && (
        <ul className="search-results route-avoid__results" role="listbox">
          {loading && matches.length === 0 && (
            <li className="search-results__item search-results__item--disabled">{t('jumpPlanner.searching')}</li>
          )}
          {matches.map((r, i) => (
            <li key={r.id} className={`search-results__item${i === keys.active ? ' search-results__item--active' : ''}`}
              role="option" aria-selected={i === keys.active} onMouseEnter={() => keys.setActive(i)}
              onMouseDown={(e) => { e.preventDefault(); add({ id: r.id, name: r.name }); }}>
              <span>{r.name}</span>
              <span className="search-results__class">{systemResultLabel(r)}</span>
            </li>
          ))}
        </ul>
      )}
      {avoided.length > 0 && (
        <div className="route-avoid__chips">
          {avoided.map((a) => (
            <span key={a.id} className="route-avoid__chip">
              {a.name}
              <button type="button" className="icon-btn" aria-label={t('mapSidebar.routeAvoidRemove', { name: a.name })}
                onClick={() => setAvoided(avoided.filter((x) => x.id !== a.id))}>
                <XIcon size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
      <p className="map-sidebar__hint">{t('mapSidebar.routeAvoidHint')}</p>
    </div>
  );
}
