import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { XIcon } from '@phosphor-icons/react';
import { useMapStore } from '../../store/mapStore';
import { FILTER_SIG_TYPES, FILTER_ANOM_TYPES, contentFilterActive, systemMatchesContent } from '../../utils/contentMatch';

// Map-wide content filter: tick the sig / anomaly types (or type a site name)
// you're looking for; matching systems stay lit and the rest fade out.
export function ContentFilterBlock() {
  const { t } = useTranslation();
  const filter = useMapStore((s) => s.contentFilter);
  const setContentFilter = useMapStore((s) => s.setContentFilter);
  const clearContentFilter = useMapStore((s) => s.clearContentFilter);
  const systems = useMapStore((s) => s.map.systems);
  const contentBySystem = useMapStore((s) => s.contentBySystem);

  const active = contentFilterActive(filter);
  const matchCount = useMemo(
    () => (active ? systems.filter((sys) => systemMatchesContent(contentBySystem[sys.id], filter)).length : 0),
    [active, systems, contentBySystem, filter],
  );

  function toggle(kind: 'sigTypes' | 'anomTypes', value: string) {
    const cur = filter[kind];
    setContentFilter({ [kind]: cur.includes(value) ? cur.filter((x) => x !== value) : [...cur, value] });
  }

  return (
    <div className="content-filter">
      <div className="map-sidebar__hint">{t('contentFilter.hint')}</div>

      <div className="map-sidebar__label">{t('contentFilter.sigs')}</div>
      <div className="content-filter__chips">
        {FILTER_SIG_TYPES.map((st) => (
          <button
            key={st}
            type="button"
            className={`sig-filter-chip${filter.sigTypes.includes(st) ? ' sig-filter-chip--active' : ''}`}
            aria-pressed={filter.sigTypes.includes(st)}
            onClick={() => toggle('sigTypes', st)}
          >
            {t(`sigType.${st}`)}
          </button>
        ))}
      </div>

      <div className="map-sidebar__label">{t('contentFilter.anoms')}</div>
      <div className="content-filter__chips">
        {FILTER_ANOM_TYPES.map((at) => (
          <button
            key={at}
            type="button"
            className={`sig-filter-chip${filter.anomTypes.includes(at) ? ' sig-filter-chip--active' : ''}`}
            aria-pressed={filter.anomTypes.includes(at)}
            onClick={() => toggle('anomTypes', at)}
          >
            {t(`anomType.${at}`)}
          </button>
        ))}
      </div>

      <input
        type="text"
        className="content-filter__name"
        value={filter.nameQuery}
        maxLength={60}
        onChange={(e) => setContentFilter({ nameQuery: e.target.value })}
        placeholder={t('contentFilter.namePlaceholder')}
        spellCheck={false}
      />

      {active && (
        <div className="content-filter__footer">
          <span className="content-filter__count">{t('contentFilter.matchCount', { count: matchCount })}</span>
          <button type="button" className="content-filter__clear" onClick={clearContentFilter}>
            <XIcon size={12} weight="bold" /> {t('contentFilter.clear')}
          </button>
        </div>
      )}
    </div>
  );
}
