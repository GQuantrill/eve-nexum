import { useTranslation } from 'react-i18next';
import { CaretLeftIcon, BinocularsIcon } from '@phosphor-icons/react';
import { useUserSetting } from '../../hooks/useUserSetting';
import { useWatchlist } from '../../hooks/useWatchlist';
import { WatchlistBlock } from './WatchlistBlock';
import { WatchlistSection } from './WatchlistSection';

// Dedicated left-docked watchlist panel. Slides in from the left edge of the
// map area; a tab handle on its right edge toggles it. Open state is per-user
// so it follows the operator across devices. Kept separate from the right-hand
// map-options sidebar because a hunting list wants room and wants to stay open
// while you map.
export function WatchlistPanel() {
  const { t } = useTranslation();
  const [open, setOpen] = useUserSetting<boolean>('nexum.watchlist.panelOpen', false);
  // Content fold state, separate from dock/undock: clicking the title bar
  // collapses everything below it to just the header (panel stays docked),
  // mirroring a sidebar section header. Persisted per-user.
  const [collapsed, setCollapsed] = useUserSetting<boolean>('nexum.watchlist.collapsed', false);
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
            <BinocularsIcon size={24} weight="bold" />
            {items.length > 0 && <span className="watchlist-panel__count">{items.length}</span>}
          </>
        )}
      </button>

      <div className="watchlist-panel__content">
        <div className="watchlist-panel__header">
          {/* Title bar doubles as the content collapse toggle (like a sidebar
              section header); the caret reflects the folded state. */}
          <button
            type="button"
            className="watchlist-panel__title-btn"
            onClick={() => setCollapsed(!collapsed)}
            aria-expanded={!collapsed}
            title={title}
          >
            <span className={`map-sidebar__caret${collapsed ? '' : ' map-sidebar__caret--open'}`}>▾</span>
            <span className="map-sidebar__section-title">{title}</span>
          </button>
          <button
            type="button"
            className="icon-btn"
            onClick={() => setOpen(false)}
            title={t('actions.close')}
            aria-label={t('actions.close')}
          >
            <CaretLeftIcon size={14} weight="bold" />
          </button>
        </div>

        {!collapsed && (
          <div className="watchlist-panel__sections">
            <WatchlistSection id="markers" title={t('watchlist.sections.markers')}>
              <WatchlistBlock />
            </WatchlistSection>
          </div>
        )}
      </div>
    </div>
  );
}
