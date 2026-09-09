import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ArrowSquareOutIcon } from '../../icons';
import { useUserSetting } from '../../hooks/useUserSetting';

interface Props {
  id: string;
  title: string;
  children: ReactNode;
  /** When provided, an "undock" button pops this card out into a floating
   *  window. Only the bottom dock passes it; the sidebar cards omit it. */
  onUndock?: () => void;
  /** Keep the body MOUNTED (just hidden) while collapsed.
   *
   *  Collapsing normally unmounts the body, which is what stops a collapsed
   *  card polling. That is right for most cards and wrong for the two that
   *  listen for a window-level paste: an unmounted pane registers no listener,
   *  so a single Ctrl+V of a full probe-scanner window silently lost whichever
   *  half belonged to a collapsed pane.
   *
   *  Only pass this for cards that must react to events they don't own. It
   *  costs their mount-time work while collapsed, so it is opt-in rather than
   *  the default. */
  keepMounted?: boolean;
}

function storageKey(id: string) { return `nexum.panel.collapsed.${id}`; }

export function DraggableCard({ id, title, children, onUndock, keepMounted = false }: Props) {
  const { t } = useTranslation();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });

  const [collapsed, setCollapsed] = useUserSetting<boolean>(storageKey(id), false);
  const toggle = () => setCollapsed(!collapsed);

  return (
    <div
      ref={setNodeRef}
      className={`info-card${collapsed ? ' info-card--collapsed' : ''}`}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.4 : 1,
        zIndex: isDragging ? 10 : undefined,
      }}
    >
      <div className="info-card__header" onClick={toggle}>
        <button
          type="button"
          className="info-card__collapse-btn"
          onClick={(e) => { e.stopPropagation(); toggle(); }}
          title={collapsed ? t('actions.expand') : t('actions.collapse')}
        >
          <span className={`info-card__chevron${collapsed ? ' info-card__chevron--collapsed' : ''}`}>▾</span>
        </button>
        <span className="info-card__title">{title}</span>
        {onUndock && (
          <button
            type="button"
            className="info-card__undock-btn"
            onClick={(e) => { e.stopPropagation(); onUndock(); }}
            title={t('panel.undock')}
            aria-label={t('panel.undock')}
          >
            <ArrowSquareOutIcon size={13} weight="regular" />
          </button>
        )}
        <button
          type="button"
          className="info-card__drag-handle"
          {...listeners}
          {...attributes}
          onClick={(e) => e.stopPropagation()}
          title={t('closest.dragToReorder')}
        >
          ⠿
        </button>
      </div>
      {!collapsed && !isDragging
        ? <div className="info-card__body">{children}</div>
        // `hidden` rather than unmounting: effects keep running, so a paste
        // listener registered by the body survives the card being collapsed.
        : keepMounted ? <div className="info-card__body" hidden>{children}</div> : null}
    </div>
  );
}
