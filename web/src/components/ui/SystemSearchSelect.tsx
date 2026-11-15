import { forwardRef, useEffect, useRef, useState } from 'react';
import type { InputHTMLAttributes, KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { useEsiSearch, systemResultLabel } from '../../hooks/useEsiSearch';
import { useSearchKeys } from '../../hooks/useSearchKeys';

interface Props {
  value: string;
  onChange: (name: string) => void;
  placeholder?: string;
  maxLength?: number;
  className?: string;
  'aria-invalid'?: InputHTMLAttributes<HTMLInputElement>['aria-invalid'];
}

// A controlled system-name input that searches the EVE system list (via
// /api/systems/search, debounced) and offers matches in a dropdown — the same
// pattern as the add-system modal, but reduced to capturing a single name
// string. Typing updates `value` live (so the watchlist's duplicate/empty
// detection keeps working); picking a result fills in the exact system name.
// The dropdown is portalled to <body> and follows scroll, so the watchlist
// panel's own overflow can't clip it.
export const SystemSearchSelect = forwardRef<HTMLInputElement, Props>(function SystemSearchSelect(
  { value, onChange, placeholder, maxLength = 48, className, ...rest }, ref,
) {
  const { results, loading } = useEsiSearch(value);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);

  const showResults = open && results.length > 0 && value.trim().length >= 2;

  // Position the portalled dropdown under the input, re-measuring on scroll /
  // resize while open so the sidebar's scroll doesn't leave it stranded.
  useEffect(() => {
    if (!showResults) { setPos(null); return; }
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
  }, [showResults]);

  function pick(name: string) {
    onChange(name);
    setOpen(false);
  }
  const keys = useSearchKeys(showResults ? results : [], value, (r) => r.name, (r) => pick(r.name));

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') { if (open) { e.stopPropagation(); setOpen(false); } return; }
    keys.onKeyDown(e);
  }

  return (
    <div className="watchlist__search search-field__wrap" ref={wrapRef}>
      <input
        ref={ref}
        type="text"
        className={className}
        value={value}
        maxLength={maxLength}
        onChange={(e) => { onChange(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        role="combobox"
        aria-expanded={showResults}
        aria-autocomplete="list"
        {...rest}
      />
      {loading && <span className="search-field__spinner" />}
      {showResults && pos && createPortal(
        <ul
          className="search-results"
          role="listbox"
          style={{ position: 'fixed', top: pos.top, left: pos.left, width: pos.width, minWidth: 240, zIndex: 2000 }}
        >
          {results.map((r, i) => (
            <li
              key={r.id}
              className={`search-results__item${i === keys.active ? ' search-results__item--active' : ''}`}
              role="option"
              aria-selected={i === keys.active}
              onMouseDown={(e) => { e.preventDefault(); pick(r.name); }}
              onMouseEnter={() => keys.setActive(i)}
            >
              <span>{r.name}</span>
              <span className="search-results__class">{systemResultLabel(r)}</span>
            </li>
          ))}
        </ul>,
        document.body,
      )}
    </div>
  );
});
