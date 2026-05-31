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

const J_SPACE: SystemClass[] = ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C13', 'Thera', 'Pochven', 'Drifter'];
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
    J_SPACE.filter(c => !q || c.includes(q) || CLASS_LABELS[c].toUpperCase().includes(q)),
    [q]);

  const filteredKSpace = useMemo(() =>
    K_SPACE.filter(c => !q || c.includes(q) || CLASS_LABELS[c].toUpperCase().includes(q)),
    [q]);

  const select = (v: string) => { onChange(v); setOpen(false); };

  const isClass = value ? value in CLASS_LABELS : false;

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
            {isClass ? (
              <span style={{ color: CLASS_COLORS[value as SystemClass], fontSize: 'calc(13px * var(--font-scale, 1))' }}>
                {CLASS_LABELS[value as SystemClass]}
              </span>
            ) : (
              <span style={{ color: '#c0d0e8', fontSize: 'calc(13px * var(--font-scale, 1))' }}>{value}</span>
            )}
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
                {filteredJSpace.map(cls => (
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
