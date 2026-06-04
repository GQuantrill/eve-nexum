import { useTranslation } from 'react-i18next';
import { CaretLeftIcon, CaretRightIcon, BinocularsIcon } from '@phosphor-icons/react';
import { useUserSetting } from '../../hooks/useUserSetting';
import { useWatchlist } from '../../hooks/useWatchlist';
import { WatchlistBlock } from './WatchlistBlock';

// Dedicated left-docked watchlist panel. Slides in from the left edge of the
// map area; a tab handle on its right edge toggles it. Open state is per-user
// so it follows the operator across devices. Kept separate from the right-hand
// map-options sidebar because a hunting list wants room and wants to stay open
// while you map.
export function WatchlistPanel() {
  const { t } = useTranslation();
  const [open, setOpen] = useUserSetting<boolean>('nexum.watchlist.panelOpen', false);
  const [items] = useWatchlist();
  const title = t('mapSidebar.sections.watchlist');

  return (
    <div className={`watchlist-panel${open ? ' watchlist-panel--open' : ''}`}>
      <button
        type="button"
        className="watchlist-panel__tab"
        onClick={() => setOpen(!open)}
        title={title}
        aria-expanded={open}
      >
        {open ? (
          <CaretLeftIcon size={14} weight="bold" />
        ) : (
          <>
            <BinocularsIcon size={16} weight="bold" />
            {items.length > 0 && <span className="watchlist-panel__count">{items.length}</span>}
          </>
        )}
      </button>

      <div className="watchlist-panel__content">
        <div className="watchlist-panel__header">
          <span className="map-sidebar__section-title">{title}</span>
          <button
            type="button"
            className="icon-btn"
            onClick={() => setOpen(false)}
            title={t('actions.close')}
            aria-label={t('actions.close')}
          >
            <CaretRightIcon size={14} weight="bold" />
          </button>
        </div>
        <WatchlistBlock />
      </div>
    </div>
  );
}
