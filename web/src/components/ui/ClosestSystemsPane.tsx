import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy, arrayMove } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { MapPinSimpleIcon, PathIcon, XIcon, PlusIcon, HouseIcon } from '@phosphor-icons/react';
import { useShallow } from 'zustand/react/shallow';
import { useCharacterLocation } from '../../hooks/useCharacterLocation';
import { useRoute, type RouteEntry } from '../../hooks/useRoute';
import { useEsiSearch } from '../../hooks/useEsiSearch';
import { useMapStore } from '../../store/mapStore';
import { useUserSetting } from '../../hooks/useUserSetting';
import { setWaypoint, RouteSquares, KSPACE_CLASSES } from './routeUi';
import { jumps as jumpsLabel } from '../../i18n/format';

// EVE system IDs for the major trade hubs. Used as the initial seed only —
// once the user has touched the list, theirs wins.
const DEFAULT_HUBS: ReadonlyArray<{ id: number; name: string }> = [
  { id: 30000142, name: 'Jita'    },
  { id: 30002187, name: 'Amarr'   },
  { id: 30002510, name: 'Rens'    },
  { id: 30002659, name: 'Dodixie' },
  { id: 30002053, name: 'Hek'     },
];

// Persist both the order AND the resolved names so the pane can label
// custom systems without making an extra round-trip on every reload.
const LIST_KEY = 'nexum.closestSystems.list';
// IDs the user has explicitly hidden when they were the current home.
// Lets someone keep their home set in-game without it cluttering this
// pane. If they later change home to a different system, the new home
// still auto-appears because its ID isn't in this set.
const HIDDEN_HOME_KEY = 'nexum.closestSystems.hiddenHome';

interface StoredEntry { id: number; name: string }

const HUB_DEFAULTS: StoredEntry[] = DEFAULT_HUBS.map((h) => ({ id: h.id, name: h.name }));

function sanitiseList(raw: unknown): StoredEntry[] {
  if (!Array.isArray(raw)) return HUB_DEFAULTS;
  return raw
    .filter((e): e is StoredEntry =>
      typeof e === 'object' && e !== null
        && typeof (e as StoredEntry).id === 'number'
        && typeof (e as StoredEntry).name === 'string')
    .map((e) => ({ id: e.id, name: e.name }));
}

interface RowItem {
  id:     number;
  name:   string;
  isHome: boolean;
  // `true` when the row is in the user's saved list — removing it just
  // takes it out of the list. The home auto-row (not in list) is also
  // removable; its remove handler adds the system ID to hiddenHome so
  // it stays gone until the user picks a different home.
  inList: boolean;
}

interface RowProps {
  item:      RowItem;
  route?:    RouteEntry;
  isOpen:    boolean;
  onToggle:  () => void;
  onRemove?: () => void;
  routeMode: string;
}

function Row({ item, route, isOpen, onToggle, onRemove, routeMode }: RowProps) {
  const { t } = useTranslation();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: String(item.id) });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };
  return (
    <div ref={setNodeRef} className="scout-row" style={style}>
      <div className="scout-row__sys">
        <button
          type="button"
          className="scout-row__drag"
          title={t('closest.dragToReorder')}
          {...listeners}
          {...attributes}
        >
          ⠿
        </button>
        <span className="scout-row__name">{item.name}</span>
        {item.isHome && (
          <span className="scout-row__home" aria-label={t('closest.home')} data-tooltip={t('closest.home')}>
            <HouseIcon size={14} weight="regular" color="#f0c040" />
          </span>
        )}
      </div>

      <div className="scout-row__actions">
        <span className="scout-row__jumps">
          {route ? jumpsLabel(t, route.jumps) : t('closest.noJumps')}
        </span>
        <button
          type="button"
          className="sys-btn scout-row__btn scout-row__btn--icon"
          onClick={() => setWaypoint(item.id, item.name, true)}
          aria-label={t('waypoint.setDestination')}
          data-tooltip={t('waypoint.setDestination')}
        >
          <MapPinSimpleIcon size={14} weight="regular" color="#3ddc84" />
        </button>
        <button
          type="button"
          className="sys-btn scout-row__btn scout-row__btn--icon"
          onClick={() => setWaypoint(item.id, item.name, false)}
          aria-label={t('waypoint.addWaypoint')}
          data-tooltip={t('waypoint.addWaypoint')}
        >
          <PathIcon size={14} weight="regular" color="#5a9af8" />
        </button>
        {route && (
          <button
            type="button"
            className="sys-btn scout-row__btn"
            onClick={onToggle}
            aria-expanded={isOpen}
          >
            {(() => {
              const mode = routeMode === 'secure' ? t('a0.modeSecure') : t('a0.modeShortest');
              return isOpen ? t('a0.hideRoute', { mode }) : t('a0.showRoute', { mode });
            })()}
          </button>
        )}
        {onRemove && (
          <button
            type="button"
            className="sys-btn scout-row__btn scout-row__btn--icon"
            onClick={onRemove}
            aria-label={t('closest.removeFromList')}
            data-tooltip={t('closest.removeFromList')}
          >
            <XIcon size={14} weight="regular" color="#e25a5a" />
          </button>
        )}
      </div>

      {route && isOpen && <RouteSquares route={route} />}
    </div>
  );
}

export function ClosestSystemsPane() {
  const { t } = useTranslation();
  const location  = useCharacterLocation();
  const routeMode = useMapStore((s) => s.routeMode);
  const homeSystem = useMapStore(useShallow((s) => {
    const found = s.map.systems.find((sys) => sys.isHome && sys.eveSystemId != null);
    return found ? { id: found.eveSystemId as number, name: found.name } : null;
  }));

  const [listRaw, setList]      = useUserSetting<StoredEntry[]>(LIST_KEY, HUB_DEFAULTS);
  const list = useMemo(() => sanitiseList(listRaw), [listRaw]);
  const [hiddenHomeArr, setHiddenHomeArr] = useUserSetting<number[]>(HIDDEN_HOME_KEY, []);
  const hiddenHome = useMemo(() => new Set(hiddenHomeArr), [hiddenHomeArr]);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [adding, setAdding]     = useState(false);
  const [query, setQuery]       = useState('');
  const [activeIndex, setActiveIndex] = useState(-1);
  const [dropdownPos, setDropdownPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const { results, loading }    = useEsiSearch(query);
  const inputRef                = useRef<HTMLInputElement>(null);
  const addRowRef               = useRef<HTMLDivElement>(null);

  useEffect(() => { if (adding) inputRef.current?.focus(); }, [adding]);
  useEffect(() => { setActiveIndex(-1); }, [results]);

  // Recompute the portal position any time the search row or results
  // shift. The portal lives on document.body so it escapes the info
  // card's overflow: hidden (which clips inline-positioned dropdowns).
  useEffect(() => {
    if (!adding) { setDropdownPos(null); return; }
    function update() {
      const el = addRowRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setDropdownPos({ top: r.bottom + 4, left: r.left, width: r.width });
    }
    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [adding, results, query]);

  const canRoute =
    location.online &&
    location.system !== null &&
    KSPACE_CLASSES.has(location.system.systemClass);

  // Items = home (auto, if present and not in list and not hidden) ++
  // user list. Every row is removable. Removing the auto-home row hides
  // it via the hiddenHome set; if the user later picks a different
  // home, that new ID isn't in the set so it auto-appears.
  const items = useMemo<RowItem[]>(() => {
    const result: RowItem[] = [];
    const seen = new Set<number>();
    for (const entry of list) {
      const isHome = homeSystem?.id === entry.id;
      result.push({ id: entry.id, name: entry.name, isHome, inList: true });
      seen.add(entry.id);
    }
    if (homeSystem && !seen.has(homeSystem.id) && !hiddenHome.has(homeSystem.id)) {
      result.unshift({ id: homeSystem.id, name: homeSystem.name, isHome: true, inList: false });
    }
    return result;
  }, [list, homeSystem, hiddenHome]);

  const targetIds = useMemo(() => items.map((i) => i.id), [items]);
  const routes    = useRoute(canRoute ? location.system!.eveSystemId : null, targetIds);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  function onDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    // Reorder only within the user list — the home auto-row (when not in
    // list) sits at the top regardless.
    const draggable = items.filter((i) => i.inList);
    const ids = draggable.map((i) => i.id);
    const a   = ids.indexOf(Number(active.id));
    const b   = ids.indexOf(Number(over.id));
    if (a < 0 || b < 0) return;
    const newOrder = arrayMove(ids, a, b);
    setList(newOrder.map((id) => list.find((e) => e.id === id)!).filter(Boolean));
  }

  function toggleExpanded(id: number) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else              next.add(id);
      return next;
    });
  }

  function removeRow(id: number) {
    setList((prev) => prev.filter((e) => e.id !== id));
    // If we just removed the current home (whether it was in the list
    // or was the auto-row), hide it so it doesn't re-appear on the
    // next render. Tracking by ID means a future home change still
    // surfaces normally.
    if (homeSystem?.id === id) {
      setHiddenHomeArr((prev) => Array.from(new Set([...prev, id])));
    }
  }

  function addSystem(id: number, name: string) {
    setList((prev) => prev.some((e) => e.id === id) ? prev : [...prev, { id, name }]);
    // Adding a system explicitly clears the hidden-home flag for it —
    // user wants it back in the list now.
    if (hiddenHome.has(id)) {
      setHiddenHomeArr((prev) => prev.filter((x) => x !== id));
    }
    setQuery('');
    setAdding(false);
  }

  if (!canRoute) {
    return (
      <div className="scout-pane__empty">
        {t('closest.signIn')}
      </div>
    );
  }

  // Show already-added systems greyed out rather than hiding them — the
  // user can see "yes I already have Jita" instead of wondering why it
  // doesn't appear.
  const existingIds = new Set(items.map((i) => i.id));
  const showResults = adding && query.trim().length >= 2;
  const showEmpty   = showResults && results.length === 0 && !loading;

  function handleAddKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      setAdding(false); setQuery(''); setActiveIndex(-1);
      return;
    }
    if (!showResults || results.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => {
        // Skip past already-added entries
        let next = Math.min(i + 1, results.length - 1);
        while (next < results.length && existingIds.has(results[next].id)) next++;
        return next >= results.length ? i : next;
      });
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => {
        let next = Math.max(i - 1, 0);
        while (next >= 0 && existingIds.has(results[next].id)) next--;
        return next < 0 ? i : next;
      });
    } else if (e.key === 'Enter' && activeIndex >= 0) {
      e.preventDefault();
      const r = results[activeIndex];
      if (r && !existingIds.has(r.id)) addSystem(r.id, r.name);
    }
  }

  return (
    <div className="scout-pane">
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={items.map((i) => String(i.id))} strategy={verticalListSortingStrategy}>
          {items.map((i) => (
            <Row
              key={i.id}
              item={i}
              route={routes[String(i.id)]}
              isOpen={expanded.has(i.id)}
              onToggle={() => toggleExpanded(i.id)}
              onRemove={() => removeRow(i.id)}
              routeMode={routeMode}
            />
          ))}
        </SortableContext>
      </DndContext>

      {!adding ? (
        <button
          type="button"
          className="sys-btn scout-pane__add"
          onClick={() => setAdding(true)}
        >
          <PlusIcon size={14} weight="bold" /> {t('addSystem.add')}
        </button>
      ) : (
        <div className="scout-pane__add-row" ref={addRowRef}>
          <input
            ref={inputRef}
            className="scout-pane__add-input"
            type="text"
            placeholder={t('closest.searchPlaceholder')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleAddKeyDown}
            spellCheck={false}
          />
          <button
            type="button"
            className="sys-btn scout-row__btn scout-row__btn--icon"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => { setAdding(false); setQuery(''); }}
            aria-label={t('actions.cancel')}
            data-tooltip={t('actions.cancel')}
          >
            <XIcon size={14} weight="regular" color="#e25a5a" />
          </button>
        </div>
      )}

      {adding && dropdownPos && showResults && results.length > 0 && createPortal(
        <ul
          className="scout-pane__add-results"
          role="listbox"
          style={{ position: 'fixed', top: dropdownPos.top, left: dropdownPos.left, width: dropdownPos.width }}
        >
          {results.slice(0, 10).map((r, i) => {
            const already = existingIds.has(r.id);
            const cls =
              'scout-pane__add-result' +
              (i === activeIndex && !already ? ' scout-pane__add-result--active' : '') +
              (already ? ' scout-pane__add-result--disabled' : '');
            return (
              <li
                key={r.id}
                className={cls}
                role="option"
                aria-selected={i === activeIndex}
                aria-disabled={already}
                onMouseEnter={() => !already && setActiveIndex(i)}
                onMouseDown={(e) => { e.preventDefault(); if (!already) addSystem(r.id, r.name); }}
              >
                <span className="scout-pane__add-result-name">{r.name}</span>
                <span className="scout-pane__add-result-region">
                  {already ? t('closest.onList') : (r.regionName ?? r.systemClass)}
                </span>
              </li>
            );
          })}
        </ul>,
        document.body,
      )}

      {adding && dropdownPos && showEmpty && createPortal(
        <div
          className="scout-pane__add-empty"
          style={{ position: 'fixed', top: dropdownPos.top, left: dropdownPos.left, width: dropdownPos.width }}
        >
          {t('closest.noMatch', { query })}
        </div>,
        document.body,
      )}
    </div>
  );
}
