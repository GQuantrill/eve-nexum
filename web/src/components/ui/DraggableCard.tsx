import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useUserSetting } from '../../hooks/useUserSetting';

interface Props {
  id: string;
  title: string;
  children: ReactNode;
}

function storageKey(id: string) { return `nexum.panel.collapsed.${id}`; }

export function DraggableCard({ id, title, children }: Props) {
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
      {!collapsed && !isDragging && <div className="info-card__body">{children}</div>}
    </div>
  );
}
