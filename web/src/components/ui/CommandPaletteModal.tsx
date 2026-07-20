import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useMapStore } from '../../store/mapStore';
import { systemDisplayName } from '../../utils/systemName';
import styles from './CommandPaletteModal.module.css';

interface Result {
  mapId:        string;
  mapName:      string;
  systemId:     string;
  systemName:   string;
  systemClass:  string;
  regionName:   string | null;
  isCurrentMap: boolean;
}

/**
 * Cmd/Ctrl-K palette to jump to any system across every map the user owns
 * or has access to. Matches by system name (prefix-preferred) and shows
 * which map each hit lives in.
 */
export function CommandPaletteModal() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const maps         = useMapStore((s) => s.maps);
  const currentMap   = useMapStore((s) => s.map);
  const switchMap    = useMapStore((s) => s.switchMap);
  const selectSystem = useMapStore((s) => s.selectSystem);

  // Cmd/Ctrl-K to open. Escape inside the palette to close.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
        // Don't block search inputs; only block if not already in a text field
        const t = e.target as HTMLElement;
        if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') return;
        e.preventDefault();
        setOpen(true);
        setQuery('');
        setActive(0);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Focus the input once visible
  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  const results: Result[] = useMemo(() => {
    if (!open) return [];
    const q = query.trim().toLowerCase();
    if (!q) return [];

    // The active `currentMap` has full systems data. The other entries in
    // `maps` only carry summary fields — they're enough to identify which
    // map a system might live on, but to actually search by system name we'd
    // need to load each. For now, search only the current map's systems plus
    // each map's name itself; selecting a non-active map switches to it.
    const out: Result[] = [];
    for (const s of currentMap.systems) {
      // Match on the real name AND the alias, so a system is findable by either.
      if (s.name.toLowerCase().includes(q) || (s.alias?.trim().toLowerCase().includes(q) ?? false)) {
        out.push({
          mapId:        currentMap.id,
          mapName:      currentMap.name,
          systemId:     s.id,
          systemName:   systemDisplayName(s),
          systemClass:  s.systemClass,
          regionName:   s.regionName,
          isCurrentMap: true,
        });
      }
    }
    // Also offer to jump to other maps by name match
    for (const m of maps) {
      if (m.id === currentMap.id) continue;
      if (m.name.toLowerCase().includes(q)) {
        out.push({
          mapId:        m.id,
          mapName:      m.name,
          systemId:     '',
          systemName:   t('commandPalette.openMap', { name: m.name }),
          systemClass:  '',
          regionName:   null,
          isCurrentMap: false,
        });
      }
    }
    // Prefix matches first, then substring
    out.sort((a, b) => {
      const ap = a.systemName.toLowerCase().startsWith(q) ? 0 : 1;
      const bp = b.systemName.toLowerCase().startsWith(q) ? 0 : 1;
      if (ap !== bp) return ap - bp;
      return a.systemName.localeCompare(b.systemName);
    });
    return out.slice(0, 30);
  }, [open, query, currentMap, maps, t]);

  function commit(r: Result) {
    if (r.systemId) {
      selectSystem(r.systemId);
    } else {
      switchMap(r.mapId).catch(console.error);
    }
    setOpen(false);
  }

  function onKeyInside(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') { setOpen(false); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, results.length - 1)); return; }
    if (e.key === 'ArrowUp')   { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); return; }
    if (e.key === 'Enter' && results[active]) { e.preventDefault(); commit(results[active]); return; }
  }

  if (!open) return null;
  return createPortal(
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) setOpen(false); }}>
      <div className={`modal ${styles.palette}`} role="dialog" aria-modal="true">
        <input
          ref={inputRef}
          className={styles.input}
          type="text"
          placeholder={t('commandPalette.placeholder')}
          value={query}
          onChange={(e) => { setQuery(e.target.value); setActive(0); }}
          onKeyDown={onKeyInside}
          aria-label={t('commandPalette.search')}
        />
        <div className={styles.list} role="listbox">
          {results.length === 0 && query && (
            <div className={styles.empty}>{t('commandPalette.noMatches')}</div>
          )}
          {results.map((r, i) => (
            <div
              key={`${r.mapId}-${r.systemId || 'map'}`}
              className={[styles.item, i === active && styles.itemActive].filter(Boolean).join(' ')}
              role="option"
              aria-selected={i === active}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => { e.preventDefault(); commit(r); }}
            >
              <span className={styles.name}>{r.systemName}</span>
              {r.systemClass && (
                <span className={styles.cls}>{r.systemClass}</span>
              )}
              <span className={styles.meta}>
                {r.regionName ? `${r.regionName} · ` : ''}
                {r.isCurrentMap ? r.mapName : t('commandPalette.switchMap')}
              </span>
            </div>
          ))}
        </div>
        <div className={styles.hint}>
          <kbd>↑↓</kbd> {t('commandPalette.navigate')} <kbd>↵</kbd> {t('commandPalette.open')} <kbd>Esc</kbd> {t('commandPalette.close')}
        </div>
      </div>
    </div>,
    document.body,
  );
}
