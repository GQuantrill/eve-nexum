import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowRightIcon, CaretDownIcon, CaretUpIcon } from '@phosphor-icons/react';
import type { MapSystem, SystemClass } from '../../types';
import { CLASS_COLORS, CLASS_LABELS } from '../../data/wormholes';
import { usePopover } from '../../hooks/usePopover';

interface Props {
  value: string;
  onChange: (leadsTo: string) => void;
  connectedSystems?: Pick<MapSystem, 'id' | 'name' | 'systemClass'>[];
}

interface DestOption { value: string; label: string; color: string; }

// Regular wormhole space (C1–C6) is grouped into the three bands EVE's
// in-game "show info" actually tells you for an unscanned hole — "unknown"
// (C1–C3), "dangerous unknown" (C4–C5) and "deadly unknown" (C6) — since you
// can't distinguish the exact class without identifying the wormhole type
// (which sets the leads-to precisely on its own). Each band is coloured by its
// worst class so the threat reads green → orange → red. C13 / Thera / Pochven /
// Drifter stay individual (their descriptions are distinct), as does K-space.
const J_SPACE: DestOption[] = [
  { value: 'C1-C3', label: 'C1-C3', color: CLASS_COLORS.C3 },
  { value: 'C4-C5', label: 'C4-C5', color: CLASS_COLORS.C5 },
  { value: 'C6',    label: 'C6',    color: CLASS_COLORS.C6 },
  { value: 'C13',     label: CLASS_LABELS.C13,     color: CLASS_COLORS.C13 },
  { value: 'Thera',   label: CLASS_LABELS.Thera,   color: CLASS_COLORS.Thera },
  { value: 'Pochven', label: CLASS_LABELS.Pochven, color: CLASS_COLORS.Pochven },
  { value: 'Drifter', label: CLASS_LABELS.Drifter, color: CLASS_COLORS.Drifter },
];
const K_SPACE: SystemClass[] = ['HS', 'LS', 'NS'];

export function LeadsToDropdown({ value, onChange, connectedSystems = [] }: Props) {
  const { t } = useTranslation();
  const { open, setOpen, pos, btnRef, dropdownRef, openAt } = usePopover();
  const [search, setSearch] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  const openPicker = () => {
    setSearch('');
    openAt();
    setTimeout(() => searchRef.current?.focus(), 0);
  };

  const q = search.trim().toUpperCase();

  const filteredConnected = useMemo(() =>
    connectedSystems.filter(s =>
      !q || s.name.toUpperCase().includes(q) || s.systemClass.includes(q)
    ), [connectedSystems, q]);

  const filteredJSpace = useMemo(() =>
    J_SPACE.filter(o => !q || o.value.toUpperCase().includes(q) || o.label.toUpperCase().includes(q)),
    [q]);

  const filteredKSpace = useMemo(() =>
    K_SPACE.filter(c => !q || c.includes(q) || CLASS_LABELS[c].toUpperCase().includes(q)),
    [q]);

  const select = (v: string) => { onChange(v); setOpen(false); };

  // Resolve the button's label + colour for any stored value: a J-space band
  // (C1-C3 / C4-C5 / C6), an exact class (incl. legacy values like a plain C2),
  // or a free-form connected-system name (neutral).
  const band = value ? J_SPACE.find((o) => o.value === value) : undefined;
  const isClass = value ? value in CLASS_LABELS : false;
  const displayColor = band ? band.color : isClass ? CLASS_COLORS[value as SystemClass] : '#c0d0e8';
  const displayLabel = band ? band.label : isClass ? CLASS_LABELS[value as SystemClass] : value;

  return (
    <div className="wh-picker">
      <button
        ref={btnRef}
        type="button"
        className={`wh-picker__btn${open ? ' wh-picker__btn--open' : ''}${!value ? ' wh-picker__btn--empty' : ''}`}
        style={{ fontFamily: 'inherit', fontWeight: value ? 600 : 'normal' }}
        onClick={openPicker}
      >
        {value ? (
          <span className="wh-picker__btn-inner">
            <span style={{ color: displayColor, fontSize: 'calc(13px * var(--font-scale, 1))' }}>
              {displayLabel}
            </span>
          </span>
        ) : (
          <span className="wh-picker__placeholder">{t('mapNode.unknown')}</span>
        )}
        <span className="wh-picker__chevron">
          {open ? <CaretUpIcon size={11} weight="bold" /> : <CaretDownIcon size={11} weight="bold" />}
        </span>
      </button>

      {open && (
        <div
          ref={dropdownRef}
          className="wh-picker__dropdown"
          style={{ position: 'fixed', top: pos.top, left: pos.left }}
        >
          <input
            ref={searchRef}
            className="wh-picker__search"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder={t('whPicker.searchPlaceholder')}
            spellCheck={false}
          />
          <div className="wh-picker__list">
            <div
              className={`wh-picker__option${!value ? ' wh-picker__option--active' : ''}`}
              onMouseDown={() => select('')}
            >
              <span className="wh-picker__placeholder">{t('mapNode.unknown')}</span>
            </div>

            {filteredConnected.length > 0 && (
              <>
                <div className="wh-picker__group-hdr">
                  {t('whPicker.connectedSystems')}
                  <span className="wh-picker__group-count">({connectedSystems.length})</span>
                </div>
                {filteredConnected.map(sys => (
                  <div
                    key={sys.id}
                    className={`wh-picker__option${value === sys.name ? ' wh-picker__option--active' : ''}`}
                    onMouseDown={() => select(sys.name || sys.id)}
                  >
                    <span className="wh-picker__code" style={{ color: '#c0d0e8', minWidth: 'auto', marginRight: 4 }}>
                      {sys.name || t('mapNode.unknown')}
                    </span>
                    <span className="wh-picker__arrow"><ArrowRightIcon size={11} weight="bold" /></span>
                    <span className="wh-picker__dest" style={{ color: CLASS_COLORS[sys.systemClass] }}>
                      {CLASS_LABELS[sys.systemClass]}
                    </span>
                  </div>
                ))}
              </>
            )}

            {filteredJSpace.length > 0 && (
              <>
                <div className="wh-picker__group-hdr">
                  J-Space
                  <span className="wh-picker__group-count">({J_SPACE.length})</span>
                </div>
                {filteredJSpace.map(o => (
                  <div
                    key={o.value}
                    className={`wh-picker__option${value === o.value ? ' wh-picker__option--active' : ''}`}
                    onMouseDown={() => select(o.value)}
                  >
                    <span className="wh-picker__dest" style={{ color: o.color }}>
                      {o.label}
                    </span>
                  </div>
                ))}
              </>
            )}

            {filteredKSpace.length > 0 && (
              <>
                <div className="wh-picker__group-hdr">
                  K-Space
                  <span className="wh-picker__group-count">({K_SPACE.length})</span>
                </div>
                {filteredKSpace.map(cls => (
                  <div
                    key={cls}
                    className={`wh-picker__option${value === cls ? ' wh-picker__option--active' : ''}`}
                    onMouseDown={() => select(cls)}
                  >
                    <span className="wh-picker__dest" style={{ color: CLASS_COLORS[cls] }}>
                      {CLASS_LABELS[cls]}
                    </span>
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
