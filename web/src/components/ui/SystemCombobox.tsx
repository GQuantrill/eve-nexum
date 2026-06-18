import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { MapSystem } from '../../types';

interface Props {
  systems: MapSystem[];
  value: string;                  // selected system id, or '' for none
  onChange: (id: string) => void;
  placeholder: string;
  excludeId?: string;             // omit this id from results (the other endpoint)
}

// Searchable single-select over the systems already on the map. Same look as
// the "add system" search (search-field / search-results), but filters local
// map systems instead of hitting ESI — so a big map doesn't render a giant
// native <select>. The dropdown is portalled to <body> so the sidebar's
// overflow can't clip it.
export function SystemCombobox({ systems, value, onChange, placeholder, excludeId }: Props) {
  const { t } = useTranslation();
  const nameById = useMemo(() => new Map(systems.map((s) => [s.id, s.name])), [systems]);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);

  const selectedName = value ? (nameById.get(value) ?? '') : '';

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return systems
      .filter((s) => s.id !== excludeId)
      .filter((s) => q === '' || s.name.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 50);
  }, [systems, query, excludeId]);

  // Position the portalled dropdown under the field; track while open.
  useEffect(() => {
    if (!open) { setPos(null); return; }
    const place = () => {
      const r = wrapRef.current?.getBoundingClientRect();
      if (r) setPos({ top: r.bottom + 4, left: r.left, width: r.width });
    };
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open, matches.length]);

  // Close when clicking outside the field or the dropdown. Listen in the
  // capture phase for pointerdown: the React Flow canvas captures map clicks
  // and stops propagation, so a bubble-phase document listener never sees them
  // — capture fires on the way down, before the canvas can swallow it.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const tgt = e.target as Node;
      if (wrapRef.current?.contains(tgt)) return;
      if ((tgt as HTMLElement).closest?.('.system-combo__results')) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [open]);

  function select(id: string) {
    onChange(id);
    setQuery('');
    setOpen(false);
    setActiveIndex(-1);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') { setOpen(false); inputRef.current?.blur(); return; }
    if (!open) { if (e.key === 'ArrowDown') setOpen(true); return; }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, matches.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && activeIndex >= 0) {
      e.preventDefault();
      select(matches[activeIndex].id);
    }
  }

  return (
    <div className="search-field system-combo" ref={wrapRef}>
      <div className="search-field__wrap">
        <input
          ref={inputRef}
          className={`search-field__input${value && !open ? ' search-field__input--selected' : ''}`}
          type="text"
          value={open ? query : selectedName}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
          role="combobox"
          aria-expanded={open}
          aria-autocomplete="list"
          onFocus={() => { setOpen(true); setQuery(''); setActiveIndex(-1); }}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); setActiveIndex(-1); }}
          onKeyDown={onKeyDown}
        />
        {value && (
          <button
            type="button"
            className="search-field__clear"
            onMouseDown={(e) => { e.preventDefault(); onChange(''); setQuery(''); }}
            aria-label={t('chains.clearSelection')}
          >
            ✕
          </button>
        )}
      </div>

      {open && pos && createPortal(
        <ul
          className="search-results system-combo__results"
          role="listbox"
          style={{ position: 'fixed', top: pos.top, left: pos.left, width: pos.width, zIndex: 2000 }}
        >
          {matches.length === 0 ? (
            <li className="search-results__item search-results__item--disabled">{t('chains.noMatch')}</li>
          ) : (
            matches.map((s, i) => (
              <li
                key={s.id}
                className={`search-results__item${i === activeIndex ? ' search-results__item--active' : ''}`}
                role="option"
                aria-selected={i === activeIndex}
                onMouseDown={(e) => { e.preventDefault(); select(s.id); }}
                onMouseEnter={() => setActiveIndex(i)}
              >
                <span>{s.name}</span>
                <span className="search-results__class">{s.systemClass}</span>
              </li>
            ))
          )}
        </ul>,
        document.body,
      )}
    </div>
  );
}
