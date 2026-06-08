import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { CaretRightIcon, CheckIcon } from '@phosphor-icons/react';

export type ContextMenuItem =
  | { separator: true }
  | {
      separator?: false;
      label: string;
      icon?: ReactNode;
      action?: () => void;
      disabled?: boolean;
      checked?: boolean;
      submenu?: ContextMenuItem[];
    };

interface Props {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

function SubMenu({ items, onClose }: { items: ContextMenuItem[]; onClose: () => void }) {
  return (
    <ul className="context-menu context-menu--sub">
      {items.map((item, i) => {
        if ('separator' in item && item.separator) {
          return <li key={i} className="context-menu__separator" role="separator" />;
        }
        const { label, icon, action, disabled, checked } = item;
        return (
          <li key={label}>
            <button
              className="context-menu__item"
              disabled={disabled}
              onMouseDown={(e) => {
                e.stopPropagation();
                if (!disabled && action) {
                  action();
                  onClose();
                }
              }}
            >
              {typeof checked === 'boolean' && (
                <span className="context-menu__check">{checked ? <CheckIcon size={14} weight="bold" /> : ''}</span>
              )}
              {icon && <span className="context-menu__icon">{icon}</span>}
              {label}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export function ContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLUListElement>(null);
  const [openSubmenu, setOpenSubmenu] = useState<number | null>(null);
  const [ready, setReady] = useState(false);

  const rowCount = items.filter((i) => !('separator' in i && i.separator)).length;
  // 34 / 12 are the row height and bottom padding the .context-menu CSS uses.
  // Brittle coupling — if the menu CSS changes, this placement math needs to
  // change with it.
  const left = Math.min(x, window.innerWidth  - 200);
  const top  = Math.min(y, window.innerHeight - rowCount * 34 - 12);

  useEffect(() => {
    const raf = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Close on a pointer-down anywhere outside the menu — capture phase so it
  // also fires over the map canvas, which stops pointer propagation in the
  // bubble phase. The containment check keeps clicks on the menu's own items
  // (and submenus, which render inside it) from closing it before they run.
  useEffect(() => {
    function onDown(e: Event) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [onClose]);

  return (
    <ul
      ref={ref}
      className={`context-menu${ready ? ' context-menu--ready' : ''}`}
      style={{ left, top }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, i) => {
        if ('separator' in item && item.separator) {
          return <li key={i} className="context-menu__separator" role="separator" />;
        }
        const { label, icon, action, disabled, checked, submenu } = item;
        return (
          <li key={label} className="context-menu__li" onMouseEnter={() => setOpenSubmenu(submenu ? i : null)}>
            <button
              className="context-menu__item"
              disabled={disabled}
              onMouseDown={(e) => {
                e.stopPropagation();
                if (!disabled && action && !submenu) {
                  action();
                  onClose();
                }
              }}
            >
              {typeof checked === 'boolean' && (
                <span className="context-menu__check">{checked ? <CheckIcon size={14} weight="bold" /> : ''}</span>
              )}
              {icon && <span className="context-menu__icon">{icon}</span>}
              {label}
              {submenu && <span className="context-menu__arrow"><CaretRightIcon size={12} weight="bold" /></span>}
            </button>
            {submenu && openSubmenu === i && (
              <SubMenu items={submenu} onClose={onClose} />
            )}
          </li>
        );
      })}
    </ul>
  );
}
