import { type ReactNode } from 'react';
import { useUserSetting } from '../../hooks/useUserSetting';

// A self-collapsing section inside the watchlist panel. Each instance owns its
// open/closed state (persisted per-user, keyed by id) so sections collapse
// independently — several can stay open at once, unlike the right sidebar's
// single-open accordion. Reuses the sidebar's section CSS so it looks identical
// to "Thera connections" et al.
export function WatchlistSection({
  id,
  title,
  defaultOpen = true,
  children,
}: {
  id: string;
  title: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useUserSetting<boolean>(`nexum.watchlist.section.${id}`, defaultOpen);
  return (
    <div className={`map-sidebar__section${open ? '' : ' map-sidebar__section--collapsed'}`}>
      <button
        type="button"
        className="map-sidebar__section-header"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <span className="map-sidebar__section-title">{title}</span>
        <span className={`map-sidebar__caret${open ? ' map-sidebar__caret--open' : ''}`}>▾</span>
      </button>
      {open && <div className="map-sidebar__section-body">{children}</div>}
    </div>
  );
}
