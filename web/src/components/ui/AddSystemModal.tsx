import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { SystemClass, WormholeEffect } from '../../types';
import { SYSTEM_CLASSES, WORMHOLE_EFFECTS, CLASS_LABELS, EFFECT_LABELS } from '../../data/wormholes';
import { useEsiSearch, fetchSystemDetail } from '../../hooks/useEsiSearch';
import { useMapStore } from '../../store/mapStore';

type SystemOpts = {
  eveSystemId?: number | null;
  effect?: WormholeEffect;
  statics?: string[];
  regionName?: string | null;
  npcType?: string | null;
};

interface Props {
  position: { x: number; y: number };
  onClose: () => void;
  /** When provided, called instead of the store's addSystem (e.g. demo mode). */
  onSubmit?: (name: string, systemClass: SystemClass, position: { x: number; y: number }, opts: SystemOpts) => void;
}

export function AddSystemModal({ position, onClose, onSubmit }: Props) {
  const { t } = useTranslation();
  const storeAddSystem = useMapStore((s) => s.addSystem);
  const map            = useMapStore((s) => s.map);

  const onMapIds   = new Set(map.systems.map((s) => s.eveSystemId).filter((id): id is number => id !== null));
  const onMapNames = new Set(map.systems.map((s) => s.name.toLowerCase()));

  function isOnMap(id: number, name: string) {
    if (onSubmit) return false;
    return onMapIds.has(id) || onMapNames.has(name.toLowerCase());
  }

  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [systemClass, setSystemClass] = useState<SystemClass>('C3');
  const [effect, setEffect] = useState<WormholeEffect>('none');
  const [statics, setStatics] = useState('');
  const [regionName, setRegionName] = useState<string | null>(null);
  const [npcType, setNpcType] = useState<string | null>(null);
  const [systemName, setSystemName] = useState('');
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const searchFieldRef = useRef<HTMLDivElement>(null);
  const [dropdownPos, setDropdownPos] = useState<{ top: number; left: number; width: number } | null>(null);

  const { results, loading } = useEsiSearch(query);

  const isSelected  = selectedId !== null;
  const showResults = !isSelected && results.length > 0 && query.length >= 2;
  const showEmpty   = !isSelected && results.length === 0 && query.length >= 2 && !loading;

  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => { setActiveIndex(-1); }, [results]);

  useEffect(() => {
    if (results.length > 0 && searchFieldRef.current) {
      const r = searchFieldRef.current.getBoundingClientRect();
      setDropdownPos({ top: r.bottom + 4, left: r.left, width: r.width });
    } else {
      setDropdownPos(null);
    }
  }, [results]);

  async function selectResult(id: number, name: string) {
    if (isOnMap(id, name)) return;

    setQuery(name);
    setSystemName(name);
    setSelectedId(id);
    inputRef.current?.focus();

    setLoadingDetail(true);
    try {
      const detail = await fetchSystemDetail(id);
      setSystemClass((detail.systemClass as SystemClass) ?? 'C3');
      setEffect((detail.effect as WormholeEffect) ?? 'none');
      setStatics(detail.statics.join(', '));
      setRegionName(detail.regionName ?? null);
      setNpcType(detail.npcType ?? null);
    } catch {
      // leave fields as-is
    } finally {
      setLoadingDetail(false);
    }
  }

  function clearSelection() {
    setQuery('');
    setSystemName('');
    setSelectedId(null);
    setActiveIndex(-1);
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  function handleInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    setQuery(e.target.value);
    setSystemName('');
    setSelectedId(null);
    setActiveIndex(-1);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      if (showResults) {
        e.stopPropagation();
        clearSelection();
      } else {
        onClose();
      }
      return;
    }

    if (!showResults) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex(i => Math.min(i + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex(i => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && activeIndex >= 0) {
      e.preventDefault();
      const r = results[activeIndex];
      if (!isOnMap(r.id, r.name)) selectResult(r.id, r.name);
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!systemName) return;
    const opts: SystemOpts = {
      eveSystemId: selectedId,
      effect,
      statics: statics.split(',').map((s) => s.trim()).filter(Boolean),
      regionName,
      npcType,
    };
    if (onSubmit) {
      onSubmit(systemName, systemClass, position, opts);
    } else {
      storeAddSystem(systemName, systemClass, position, opts);
    }
    onClose();
  }

  const isWormhole = ['C1','C2','C3','C4','C5','C6','Thera','Pochven','Drifter'].includes(systemClass);

  return (
    <>
    {createPortal(
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true">
        <div className="modal__header">
          <h2 className="modal__title">{t('addSystem.title')}</h2>
          <button className="icon-btn" onClick={onClose}>✕</button>
        </div>

        <form className="modal__body" onSubmit={handleSubmit}>
          <div className="search-field" ref={searchFieldRef}>
            <label className="field__label">{t('addSystem.systemName')}</label>
            <div className="search-field__wrap">
              <input
                ref={inputRef}
                className={`search-field__input${isSelected ? ' search-field__input--selected' : ''}`}
                type="text"
                value={query}
                onChange={handleInputChange}
                onKeyDown={handleKeyDown}
                placeholder={t('addSystem.searchPlaceholder')}
                autoComplete="off"
                role="combobox"
                aria-expanded={showResults}
                aria-autocomplete="list"
                readOnly={isSelected}
              />
              {isSelected && (
                <button
                  type="button"
                  className="search-field__clear"
                  onClick={clearSelection}
                  aria-label={t('addSystem.clearSelection')}
                >
                  ✕
                </button>
              )}
              {loading && !isSelected && <span className="search-field__spinner" />}
            </div>


            {showEmpty && (
              <p className="search-field__empty">{t('addSystem.noResults', { query })}</p>
            )}
          </div>

          {isSelected && isWormhole && (
          <div className="modal__row">
            <label className="field">
              <span>{t('addSystem.class')}</span>
              <select
                value={systemClass}
                onChange={(e) => setSystemClass(e.target.value as SystemClass)}
                disabled={loadingDetail}
              >
                {SYSTEM_CLASSES.map((c) => (
                  <option key={c} value={c}>{CLASS_LABELS[c]}</option>
                ))}
              </select>
            </label>

            <label className="field">
              <span>{t('addSystem.effect')}</span>
              <select
                value={effect}
                onChange={(e) => setEffect(e.target.value as WormholeEffect)}
                disabled={loadingDetail}
              >
                {WORMHOLE_EFFECTS.map((ef) => (
                  <option key={ef} value={ef}>{EFFECT_LABELS[ef] || t('addSystem.effectNone')}</option>
                ))}
              </select>
            </label>
          </div>
          )}

          {isSelected && isWormhole && (
            <label className="field">
              <span>{t('addSystem.statics')}</span>
              <input
                type="text"
                value={statics}
                onChange={(e) => setStatics(e.target.value)}
                placeholder={t('addSystem.staticsPlaceholder')}
                disabled={loadingDetail || !isSelected}
              />
            </label>
          )}

          <div className="modal__actions">
            <button type="button" className="btn btn--ghost" onClick={onClose}>{t('actions.cancel')}</button>
            <button
              type="submit"
              className="btn btn--primary"
              disabled={!systemName || loadingDetail}
            >
              {loadingDetail ? t('addSystem.loading') : t('addSystem.add')}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
    )}
    {showResults && dropdownPos && createPortal(
      <ul
        className="search-results"
        role="listbox"
        style={{ position: 'fixed', top: dropdownPos.top, left: dropdownPos.left, width: dropdownPos.width, zIndex: 2000 }}
      >
        {results.map((r, i) => {
          const alreadyOnMap = isOnMap(r.id, r.name);
          return (
            <li
              key={r.id}
              className={`search-results__item${i === activeIndex && !alreadyOnMap ? ' search-results__item--active' : ''}${alreadyOnMap ? ' search-results__item--disabled' : ''}`}
              role="option"
              aria-disabled={alreadyOnMap}
              onMouseDown={(e) => { e.preventDefault(); selectResult(r.id, r.name); }}
              onMouseEnter={() => !alreadyOnMap && setActiveIndex(i)}
            >
              <span>{r.name}</span>
              <span className="search-results__class">
                {alreadyOnMap ? t('addSystem.onMap') : (r.regionName ?? r.systemClass)}
              </span>
            </li>
          );
        })}
      </ul>,
      document.body,
    )}
    </>
  );
}
