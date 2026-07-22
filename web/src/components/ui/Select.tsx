import { useEffect, useRef, useState } from 'react';
import type { ReactNode, KeyboardEvent } from 'react';
import { CaretDownIcon, CaretUpIcon, CheckIcon } from '@phosphor-icons/react';
import { usePopover } from '../../hooks/usePopover';
import styles from './Select.module.css';

export interface SelectOption<V extends string = string> {
  value:      V;
  label:      ReactNode;
  /** Plain-text used for the label when it's not a string — powers type-ahead
   *  and the trigger's accessible name. Falls back to the value. */
  text?:      string;
  disabled?:  boolean;
}

interface SelectProps<V extends string = string> {
  value:        V;
  onChange:     (value: V) => void;
  options:      SelectOption<V>[];
  placeholder?: string;
  /** Accessible name for the control (there's no visible <label> in most uses). */
  ariaLabel?:   string;
  /** Extra class on the wrapper — for width / flex context at the call site. */
  className?:   string;
  disabled?:    boolean;
  id?:          string;
  /** Show a leading tick on the selected row. Default true. */
  showCheck?:   boolean;
}

const optText = <V extends string>(o: SelectOption<V>): string =>
  o.text ?? (typeof o.label === 'string' ? o.label : String(o.value));

/**
 * Themed, accessible drop-in for a native <select>. Keyboard model mirrors a
 * native select (Up/Down/Home/End/Enter/Space/Esc + type-ahead); ARIA uses the
 * button + listbox pattern. Opens a dark on-theme dropdown via usePopover rather
 * than the OS-default list. No <optgroup> support (nothing in the app needs it).
 */
export function Select<V extends string = string>({
  value, onChange, options, placeholder, ariaLabel, className, disabled, id, showCheck = true,
}: SelectProps<V>) {
  const { open, setOpen, pos, btnRef, dropdownRef, openAt } = usePopover();
  const listRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(-1);        // keyboard-highlighted index
  const [minW, setMinW]     = useState<number>();  // dropdown min-width = trigger width
  const typed = useRef({ str: '', at: 0 });

  const selectedIdx = options.findIndex((o) => o.value === value);
  const selected    = selectedIdx >= 0 ? options[selectedIdx] : undefined;

  const openList = () => {
    if (disabled) return;
    setActive(selectedIdx >= 0 ? selectedIdx : firstEnabled());
    setMinW(btnRef.current?.offsetWidth);          // measured in the click handler, not during render
    openAt();
  };
  const close = (refocus = true) => { setOpen(false); if (refocus) btnRef.current?.focus(); };

  const choose = (i: number) => {
    const o = options[i];
    if (!o || o.disabled) return;
    onChange(o.value);
    close();
  };

  const firstEnabled = () => options.findIndex((o) => !o.disabled);
  const lastEnabled  = () => { for (let i = options.length - 1; i >= 0; i--) if (!options[i].disabled) return i; return -1; };
  // Step to the next non-disabled option, wrapping.
  const step = (from: number, dir: 1 | -1) => {
    const n = options.length;
    for (let k = 1; k <= n; k++) {
      const i = ((from + dir * k) % n + n) % n;
      if (!options[i].disabled) return i;
    }
    return from;
  };

  // Type-ahead: accumulate keystrokes within 700ms and jump to the first option
  // whose text starts with the buffer (like a native select).
  const typeahead = (ch: string) => {
    const now = Date.now();
    const t = typed.current;
    t.str = now - t.at > 700 ? ch : t.str + ch;
    t.at = now;
    const q = t.str.toLowerCase();
    const hit = options.findIndex((o) => !o.disabled && optText(o).toLowerCase().startsWith(q));
    if (hit < 0) return;
    if (open) setActive(hit); else onChange(options[hit].value);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (disabled) return;
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) { e.preventDefault(); openList(); }
      else if (e.key.length === 1) { typeahead(e.key); }   // type-ahead while closed changes value
      return;
    }
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); setActive((i) => step(i < 0 ? -1 : i, 1)); break;
      case 'ArrowUp':   e.preventDefault(); setActive((i) => step(i < 0 ? 0 : i, -1)); break;
      case 'Home':      e.preventDefault(); setActive(firstEnabled()); break;
      case 'End':       e.preventDefault(); setActive(lastEnabled()); break;
      case 'Enter':
      case ' ':         e.preventDefault(); choose(active); break;
      case 'Escape':    e.preventDefault(); close(); break;
      case 'Tab':       close(false); break;
      default:          if (e.key.length === 1) typeahead(e.key);
    }
  };

  // Keep the keyboard-active row scrolled into view.
  useEffect(() => {
    if (!open || active < 0) return;
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  return (
    <div className={className ? `${styles.select} ${className}` : styles.select}>
      <button
        ref={btnRef}
        id={id}
        type="button"
        className={`${styles.trigger}${open ? ` ${styles.triggerOpen}` : ''}`}
        onClick={() => (open ? close(false) : openList())}
        onKeyDown={onKeyDown}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
      >
        <span className={styles.value}>
          {selected ? selected.label : <span className={styles.placeholder}>{placeholder ?? ''}</span>}
        </span>
        <span className={styles.chevron}>
          {open ? <CaretUpIcon size={11} weight="bold" /> : <CaretDownIcon size={11} weight="bold" />}
        </span>
      </button>

      {open && (
        <div
          ref={dropdownRef}
          className={styles.dropdown}
          role="listbox"
          aria-label={ariaLabel}
          style={{ position: 'fixed', left: pos.left, top: pos.top, maxHeight: pos.maxHeight, minWidth: minW }}
        >
          <div ref={listRef} className={styles.list}>
            {options.map((o, i) => {
              const isSel = o.value === value;
              const cls = [
                styles.option,
                isSel && styles.optionSelected,
                i === active && styles.optionActive,
                o.disabled && styles.optionDisabled,
              ].filter(Boolean).join(' ');
              return (
                <div
                  key={o.value}
                  data-idx={i}
                  role="option"
                  aria-selected={isSel}
                  aria-disabled={o.disabled || undefined}
                  className={cls}
                  // mousedown (not click) so the choice registers before the
                  // button's blur/outside-click closes the popover.
                  onMouseDown={(e) => { e.preventDefault(); choose(i); }}
                  onMouseEnter={() => setActive(i)}
                >
                  {showCheck && <span className={styles.check}>{isSel && <CheckIcon size={12} weight="bold" />}</span>}
                  <span className={styles.value}>{o.label}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
