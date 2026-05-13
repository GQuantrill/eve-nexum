import { useState } from 'react';
import type { ReactNode } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

interface Props {
  id: string;
  title: string;
  children: ReactNode;
}

function storageKey(id: string) { return `nexum.panel.collapsed.${id}`; }

export function DraggableCard({ id, title, children }: Props) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });

  const [collapsed, setCollapsed] = useState(() => {
    return localStorage.getItem(storageKey(id)) === 'true';
  });

  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    localStorage.setItem(storageKey(id), String(next));
  };

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
      <div className="info-card__header">
        <button type="button" className="info-card__collapse-btn" onClick={toggle} title={collapsed ? 'Expand' : 'Collapse'}>
          <span className={`info-card__chevron${collapsed ? ' info-card__chevron--collapsed' : ''}`}>▾</span>
        </button>
        <span className="info-card__title">{title}</span>
        <button type="button" className="info-card__drag-handle" {...listeners} {...attributes} title="Drag to reorder">
          ⠿
        </button>
      </div>
      {!collapsed && !isDragging && <div className="info-card__body">{children}</div>}
    </div>
  );
}
