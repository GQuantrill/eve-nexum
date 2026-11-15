import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useSearchKeys } from '../../hooks/useSearchKeys';

export interface ComboboxOption {
  value:  string;
  label:  string;
  /** Muted text on the right of the row (e.g. a system's class). */
  hint?:  ReactNode;
  /** What the search matches against; defaults to the label. */
  search?: string;
}

interface Props {
  options:     ComboboxOption[];
  value:       string;                  // selected value, or '' for none
  onChange:    (value: string) => void;
  placeholder: string;
  /** Shown in the list when nothing matches the search. */
  noMatchText: string;
  /** Adds a ✕ that clears the value, with this accessible name. */
  clearLabel?: string;
  /** Cap on rows rendered at once, so a huge list stays quick. */
  limit?:      number;
  ariaLabel?:  string;
}

// Case-insensitive, and '_' / '/' read as spaces, so "new york" finds
// America/New_York.
const norm = (s: string) => s.toLowerCase().replace(/[_/]+/g, ' ');

// Searchable single-select: type to filter, arrows + Enter to pick. Same look
// as the "add system" search (search-field / search-results). The dropdown is
// portalled to <body> so a sidebar or pane's overflow can't clip it.
export function Combobox({ options, value, onChange, placeholder, noMatchText, clearLabel, limit = 50, ariaLabel }: Props) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);

  const selectedLabel = options.find((o) => o.value === value)?.label ?? '';

  const matches = useMemo(() => {
    const q = norm(query.trim());
    return options.filter((o) => q === '' || norm(o.search ?? o.label).includes(q)).slice(0, limit);
  }, [options, query, limit]);

  // Position the portalled dropdown under the field; track while open.
  useEffect(() => {
    // Deliberate: clears the portalled dropdown position when it closes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
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

  function select(next: string) {
    onChange(next);
    setQuery('');
    setOpen(false);
  }
  const keys = useSearchKeys(open ? matches : [], query, (o) => o.label, (o) => select(o.value));

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') { setOpen(false); inputRef.current?.blur(); return; }
    if (!open) { if (e.key === 'ArrowDown') setOpen(true); return; }
    keys.onKeyDown(e);
  }

  return (
    <div className="search-field system-combo" ref={wrapRef}>
      <div className="search-field__wrap">
        <input
          ref={inputRef}
          className={`search-field__input${value && !open ? ' search-field__input--selected' : ''}`}
          type="text"
          value={open ? query : selectedLabel}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
          role="combobox"
          aria-label={ariaLabel}
          aria-expanded={open}
          aria-autocomplete="list"
          onFocus={() => { setOpen(true); setQuery(''); keys.reset(); }}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onKeyDown={onKeyDown}
        />
        {clearLabel && value && (
          <button
            type="button"
            className="search-field__clear"
            onMouseDown={(e) => { e.preventDefault(); onChange(''); setQuery(''); }}
            aria-label={clearLabel}
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
            <li className="search-results__item search-results__item--disabled">{noMatchText}</li>
          ) : (
            matches.map((o, i) => (
              <li
                key={o.value}
                className={`search-results__item${i === keys.active ? ' search-results__item--active' : ''}`}
                role="option"
                aria-selected={i === keys.active}
                onMouseDown={(e) => { e.preventDefault(); select(o.value); }}
                onMouseEnter={() => keys.setActive(i)}
              >
                <span>{o.label}</span>
                {o.hint != null && <span className="search-results__class">{o.hint}</span>}
              </li>
            ))
          )}
        </ul>,
        document.body,
      )}
    </div>
  );
}
