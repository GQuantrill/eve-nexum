import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowRightIcon, CaretDownIcon, CaretUpIcon } from '@phosphor-icons/react';
import { CLASS_COLORS, CLASS_LABELS, WORMHOLE_DESTINATIONS } from '../../data/wormholes';
import { useWormholeTypes } from '../../hooks/useWormholeTypes';
import { usePopover } from '../../hooks/usePopover';
import type { SystemClass } from '../../types';

interface Props {
  value: string;
  onChange: (whType: string, leadsTo: string) => void;
  statics?: string[];
}

// Map server's lowercase `dest` values to the SystemClass union used by
// CLASS_COLORS / CLASS_LABELS.
const DEST_TO_CLASS: Record<string, SystemClass> = {
  c1: 'C1', c2: 'C2', c3: 'C3', c4: 'C4', c5: 'C5', c6: 'C6', c13: 'C13',
  hs: 'HS', ls: 'LS', ns: 'NS',
  thera: 'Thera', pochven: 'Pochven', drifter: 'Drifter',
};

// Display order for the picker's groups. Anything from the server whose
// `dest` isn't covered here still gets shown — appended at the bottom under
// "Other" — so brand-new dest classes don't silently disappear.
const GROUP_ORDER: { key: string; label: string; dest: SystemClass }[] = [
  { key: 'k162',    label: 'K162',     dest: 'C1' /* placeholder, K162 handled specially */ },
  { key: 'highsec', label: 'Hi-Sec',   dest: 'HS' },
  { key: 'lowsec',  label: 'Low-Sec',  dest: 'LS' },
  { key: 'nullsec', label: 'Null-Sec', dest: 'NS' },
  { key: 'c1',      label: 'Class 1',  dest: 'C1' },
  { key: 'c2',      label: 'Class 2',  dest: 'C2' },
  { key: 'c3',      label: 'Class 3',  dest: 'C3' },
  { key: 'c4',      label: 'Class 4',  dest: 'C4' },
  { key: 'c5',      label: 'Class 5',  dest: 'C5' },
  { key: 'c6',      label: 'Class 6',  dest: 'C6' },
  { key: 'c13',     label: 'C13',      dest: 'C13' },
  { key: 'thera',   label: 'Thera',    dest: 'Thera' },
  { key: 'pochven', label: 'Pochven',  dest: 'Pochven' },
  { key: 'drifter', label: 'Drifter',  dest: 'Drifter' },
];

function destFor(code: string, types: ReturnType<typeof useWormholeTypes>): SystemClass | null {
  const fromServer = types[code]?.dest;
  if (fromServer) return DEST_TO_CLASS[fromServer.toLowerCase()] ?? null;
  return WORMHOLE_DESTINATIONS[code] ?? null;
}

function DestBadge({ code, types }: { code: string; types: ReturnType<typeof useWormholeTypes> }) {
  const dest = destFor(code, types);
  if (!dest) return null;
  return (
    <>
      <span className="wh-picker__arrow"><ArrowRightIcon size={11} weight="bold" /></span>
      <span className="wh-picker__dest" style={{ color: CLASS_COLORS[dest] }}>
        {CLASS_LABELS[dest] ?? dest}
      </span>
    </>
  );
}

export function WormholeTypePicker({ value, onChange, statics = [] }: Props) {
  const { t } = useTranslation();
  const types = useWormholeTypes();
  const { open, setOpen, pos, btnRef, dropdownRef, openAt } = usePopover();
  const [search, setSearch] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  const openPicker = () => {
    setSearch('');
    openAt();
    setTimeout(() => searchRef.current?.focus(), 0);
  };

  const select = (code: string) => {
    const dest = code === 'K162' ? null : destFor(code, types);
    onChange(code, dest ?? '');
    setOpen(false);
  };

  const q = search.trim().toUpperCase();

  const groups = useMemo(() => {
    const result: { key: string; label: string; types: string[]; totalCount: number }[] = [];

    if (statics.length > 0 && !q) {
      result.push({ key: '__statics', label: 'System Statics', types: statics, totalCount: statics.length });
    }

    // K162 always shown at the top of the actual code list (unless the
    // search filters it out). It has no fixed destination — handled
    // specially everywhere.
    if (!q || 'K162'.includes(q)) {
      result.push({ key: 'k162', label: 'K162', types: ['K162'], totalCount: 1 });
    }

    // Build a code list per group from the server data. Track which codes
    // we've placed so anything with an unrecognised dest can be surfaced
    // under "Other" rather than disappearing.
    const placed = new Set<string>(['K162']);
    for (const group of GROUP_ORDER) {
      if (group.key === 'k162') continue;
      const all: string[] = [];
      for (const [code, spec] of Object.entries(types)) {
        if (code === 'K162') continue;
        if (DEST_TO_CLASS[spec.dest.toLowerCase()] !== group.dest) continue;
        all.push(code);
      }
      all.sort();
      for (const c of all) placed.add(c);
      const filtered = q ? all.filter((c) => c.includes(q)) : all;
      if (filtered.length > 0) {
        result.push({ key: group.key, label: group.label, types: filtered, totalCount: all.length });
      }
    }

    // Server codes whose dest didn't match any known group bucket — e.g. a
    // future class CCP adds. Stays visible instead of vanishing.
    const other: string[] = [];
    for (const code of Object.keys(types)) {
      if (placed.has(code)) continue;
      other.push(code);
    }
    other.sort();
    const otherFiltered = q ? other.filter((c) => c.includes(q)) : other;
    if (otherFiltered.length > 0) {
      result.push({ key: '__other', label: 'Other', types: otherFiltered, totalCount: other.length });
    }

    return result;
  }, [types, statics, q]);

  return (
    <div className="wh-picker">
      <button
        ref={btnRef}
        type="button"
        className={`wh-picker__btn${open ? ' wh-picker__btn--open' : ''}${!value ? ' wh-picker__btn--empty' : ''}`}
        onClick={openPicker}
      >
        {value ? (
          <span className="wh-picker__btn-inner">
            <span className="wh-picker__code">{value}</span>
            <DestBadge code={value} types={types} />
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
              onMouseDown={() => { onChange('', ''); setOpen(false); }}
            >
              <span className="wh-picker__placeholder">{t('mapNode.unknown')}</span>
            </div>
            {groups.map(group => (
              <div key={group.key}>
                <div className="wh-picker__group-hdr">
                  {group.key === '__other' ? t('whPicker.other') : group.label}
                  <span className="wh-picker__group-count">({group.totalCount})</span>
                </div>
                {group.types.map(code => (
                  <div
                    key={code}
                    className={`wh-picker__option${value === code ? ' wh-picker__option--active' : ''}`}
                    onMouseDown={() => select(code)}
                  >
                    <span className="wh-picker__code">{code}</span>
                    <DestBadge code={code} types={types} />
                    {code === 'K162' && (
                      <span className="wh-picker__inbound">{t('whPicker.inbound')}</span>
                    )}
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
