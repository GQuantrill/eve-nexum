import { CaretDownIcon, CaretUpIcon } from '@phosphor-icons/react';
import { CLASS_COLORS, CLASS_LABELS } from '../../data/wormholes';
import { usePopover } from '../../hooks/usePopover';
import type { SystemClass } from '../../types';

interface Props {
  value: SystemClass;
  onChange: (cls: SystemClass) => void;
  /** The classes to offer, in display order. Split into J-Space / K-Space
   *  groups for the dropdown. */
  classes: SystemClass[];
}

const K_SPACE = new Set<SystemClass>(['HS', 'LS', 'NS']);

/**
 * A single-class picker styled like the connection leads-to dropdown
 * (LeadsToDropdown): a coloured class label on the button, and a grouped
 * J-Space / K-Space popover of colour-coded classes. Shows individual classes
 * (C1, C2, …) rather than the bands LeadsToDropdown uses — same look, finer
 * content. Used by the watchlist "Leads to" match.
 */
export function ClassPicker({ value, onChange, classes }: Props) {
  const { open, setOpen, pos, btnRef, dropdownRef, openAt } = usePopover();

  const jspace = classes.filter((c) => !K_SPACE.has(c));
  const kspace = classes.filter((c) => K_SPACE.has(c));
  const groups = [
    { key: 'j', label: 'J-Space', items: jspace },
    { key: 'k', label: 'K-Space', items: kspace },
  ].filter((g) => g.items.length > 0);

  const select = (c: SystemClass) => { onChange(c); setOpen(false); };

  return (
    <div className="wh-picker">
      <button
        ref={btnRef}
        type="button"
        className={`wh-picker__btn${open ? ' wh-picker__btn--open' : ''}`}
        style={{ fontFamily: 'inherit', fontWeight: 600 }}
        onClick={openAt}
      >
        <span className="wh-picker__btn-inner">
          <span style={{ color: CLASS_COLORS[value], fontSize: 'calc(13px * var(--font-scale, 1))' }}>
            {CLASS_LABELS[value] ?? value}
          </span>
        </span>
        <span className="wh-picker__chevron">
          {open ? <CaretUpIcon size={11} weight="bold" /> : <CaretDownIcon size={11} weight="bold" />}
        </span>
      </button>

      {open && (
        <div
          ref={dropdownRef}
          className="wh-picker__dropdown"
          style={{ position: 'fixed', left: pos.left, top: pos.top, maxHeight: pos.maxHeight }}
        >
          <div className="wh-picker__list">
            {groups.map((g) => (
              <div key={g.key}>
                <div className="wh-picker__group-hdr">
                  {g.label}
                  <span className="wh-picker__group-count">({g.items.length})</span>
                </div>
                {g.items.map((c) => (
                  <div
                    key={c}
                    className={`wh-picker__option${value === c ? ' wh-picker__option--active' : ''}`}
                    onMouseDown={() => select(c)}
                  >
                    <span className="wh-picker__dest" style={{ color: CLASS_COLORS[c] }}>
                      {CLASS_LABELS[c] ?? c}
                    </span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
