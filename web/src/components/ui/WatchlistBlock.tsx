import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { v4 as uuid } from 'uuid';
import { TrashIcon, PlusIcon, CrosshairIcon, ListPlusIcon, CaretDownIcon } from '@phosphor-icons/react';
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import type { DragEndEvent, Modifier } from '@dnd-kit/core';
import {
  SortableContext, verticalListSortingStrategy, arrayMove, useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useMapStore } from '../../store/mapStore';
import { useWatchlist, MAX_WATCH } from '../../hooks/useWatchlist';
import { useUserSetting } from '../../hooks/useUserSetting';
import { WATCH_MARKERS, watchMarker } from '../../data/watchMarkers';
import { WATCH_CHARACTERISTICS } from '../../data/watchCharacteristics';
import { matchKey, systemMatchesEntry, connectionMatchesEntry } from '../../utils/watchMatch';
import { CLASS_LABELS, EFFECT_LABELS } from '../../data/wormholes';
import { SystemSearchSelect } from './SystemSearchSelect';
import { WormholeTypePicker } from './WormholeTypePicker';
import { PromptModal } from './PromptModal';
import type { WatchEntry, WatchMatch, WatchMarkerKind } from '../../types';

// Watchlist rows reorder on the vertical axis only — zero the X component so
// the drag transform and collision detection both lock vertically (matching
// the sidebar panel reorder and the chains list).
const restrictToVerticalAxis: Modifier = ({ transform }) => ({ ...transform, x: 0 });

// Thin sortable wrapper: owns the row's drag plumbing (ref/transform) but hands
// the drag-handle props back via render-prop, so all the row's controls and
// closures stay in WatchlistBlock instead of being threaded through props.
function SortableWatchRow(
  { id, disabled, children }:
  { id: string; disabled: boolean; children: (p: { handleProps: Record<string, unknown> }) => ReactNode },
) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id, disabled });
  return (
    <div
      ref={setNodeRef}
      className="watchlist__row"
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.4 : 1,
        zIndex: isDragging ? 10 : undefined,
      }}
    >
      {children({ handleProps: { ...listeners, ...attributes } })}
    </div>
  );
}

// Human label for a non-typed (characteristic) match — shown read-only on the
// row, since those are added/removed via the quick-add palette.
function matchLabel(m: WatchMatch): string {
  switch (m.by) {
    case 'class':    return m.cls === 'C13' ? 'Shattered' : CLASS_LABELS[m.cls];
    case 'effect':   return EFFECT_LABELS[m.effect];
    case 'frigHole': return 'Frig holes';
    default:         return '';
  }
}

export function WatchlistBlock() {
  const { t } = useTranslation();
  const [items, setItems] = useWatchlist();
  const [soundOn, setSoundOn] = useUserSetting<boolean>('nexum.watchlist.sound', true);
  const [collapsedGroups, setCollapsedGroups] = useUserSetting<string[]>('nexum.watchlist.collapsedGroups', []);
  const [autoFocusId, setAutoFocusId] = useState<string | null>(null);

  // Bulk-import form state (paste J-codes / system names, one per line or comma-
  // separated, into a named group).
  const [importOpen, setImportOpen]     = useState(false);
  const [importName, setImportName]     = useState('');
  const [importMarker, setImportMarker] = useState<WatchMarkerKind>('watch');
  const [importText, setImportText]     = useState('');
  const [newGroupOpen, setNewGroupOpen] = useState(false);

  const systems     = useMapStore((s) => s.map.systems);
  const connections = useMapStore((s) => s.map.connections);
  const sigTypesBySystem = useMapStore((s) => s.sigTypesBySystem);
  const requestCenterOnNode = useMapStore((s) => s.requestCenterOnNode);

  const sysById = useMemo(() => new Map(systems.map((s) => [s.id, s])), [systems]);

  // The map nodes each entry currently matches (with a display label) — drives
  // the "show on map" button + its expandable list. Connection matches centre
  // on an endpoint node, since connections have no node of their own. Cheap: a
  // few entries over the map's systems/edges.
  const matchTargets = useMemo(() => {
    const m = new Map<string, { nodeId: string; label: string }[]>();
    for (const it of items) {
      const seen = new Set<string>();
      const targets: { nodeId: string; label: string }[] = [];
      const push = (nodeId: string | undefined) => {
        if (!nodeId || seen.has(nodeId)) return;
        seen.add(nodeId);
        targets.push({ nodeId, label: sysById.get(nodeId)?.name || '?' });
      };
      for (const s of systems) if (systemMatchesEntry(it, s, sigTypesBySystem[s.id])) push(s.id);
      for (const c of connections) if (connectionMatchesEntry(it, c)) push(c.sourceId || c.targetId);
      targets.sort((a, b) => a.label.localeCompare(b.label));
      m.set(it.id, targets);
    }
    return m;
  }, [items, systems, connections, sigTypesBySystem, sysById]);

  // Which entry's match list is expanded (only relevant when an entry has >1
  // match). A single match jumps straight to it; multiple toggle the list.
  const [expandedId, setExpandedId] = useState<string | null>(null);
  function locate(entryId: string) {
    const targets = matchTargets.get(entryId);
    if (!targets || targets.length === 0) return;
    if (targets.length === 1) { requestCenterOnNode(targets[0].nodeId); return; }
    setExpandedId((cur) => (cur === entryId ? null : entryId));
  }

  const activeKeys = useMemo(() => new Set(items.map((it) => matchKey(it.match))), [items]);

  // Entries whose match collides with an earlier one (same matchKey) — flagged
  // so a manually-typed duplicate is caught the moment it matches. Empty
  // placeholders are skipped (a freshly-added blank row isn't a duplicate until
  // it's filled in), and the first occurrence stays valid; later ones are the
  // duplicates. Characteristics can't collide (quick-add already dedupes them)
  // but are included for completeness.
  const dupIds = useMemo(() => {
    const seen = new Set<string>();
    const dups = new Set<string>();
    for (const it of items) {
      const m = it.match;
      const complete =
        (m.by === 'system' && m.query.trim() !== '') ||
        (m.by === 'whType' && m.code.trim() !== '') ||
        (m.by !== 'system' && m.by !== 'whType');
      if (!complete) continue;
      const k = matchKey(m);
      if (seen.has(k)) dups.add(it.id);
      else seen.add(k);
    }
    return dups;
  }, [items]);

  const atCap = items.length >= MAX_WATCH;
  const room  = Math.max(0, MAX_WATCH - items.length);

  // Ungrouped entries (shown at the top, always visible) + named groups (in
  // first-seen order) that fold away. Collapse state persists per user.
  const ungrouped = useMemo(() => items.filter((it) => !it.group), [items]);
  const groups = useMemo(() => {
    const m = new Map<string, WatchEntry[]>();
    for (const it of items) {
      if (!it.group) continue;
      const arr = m.get(it.group);
      if (arr) arr.push(it); else m.set(it.group, [it]);
    }
    return m;
  }, [items]);
  const collapsed = useMemo(() => new Set(collapsedGroups), [collapsedGroups]);

  function addManual() {
    if (atCap) return;
    const next: WatchEntry = { id: uuid(), match: { by: 'system', query: '' }, note: '', marker: 'target' };
    setItems([...items, next]);
    setAutoFocusId(next.id);
  }

  function toggleGroupCollapsed(name: string) {
    setCollapsedGroups((prev) => (prev.includes(name) ? prev.filter((g) => g !== name) : [...prev, name]));
  }

  function addToGroup(name: string) {
    if (atCap) return;
    const next: WatchEntry = { id: uuid(), match: { by: 'system', query: '' }, note: '', marker: 'target', group: name };
    setItems([...items, next]);
    setCollapsedGroups((prev) => prev.filter((g) => g !== name)); // expand so the new row is visible
    setAutoFocusId(next.id);
  }

  function deleteGroup(name: string) {
    setItems(items.filter((it) => it.group !== name));
    setCollapsedGroups((prev) => prev.filter((g) => g !== name));
  }

  function runImport() {
    const name = importName.trim();
    if (!name || atCap) return;
    // Split on newlines AND commas; trim, drop blanks, dedupe within the paste.
    const tokens = [...new Set(importText.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean))];
    const take = tokens.slice(0, room);
    if (take.length === 0) return;
    const added: WatchEntry[] = take.map((query) => ({
      id: uuid(), match: { by: 'system', query }, note: '', marker: importMarker, group: name,
    }));
    setItems([...items, ...added]);
    setImportText('');
    setImportName('');
    setImportOpen(false);
  }

  function toggleCharacteristic(match: WatchMatch, marker: WatchMarkerKind) {
    const mk = matchKey(match);
    if (activeKeys.has(mk)) {
      setItems(items.filter((it) => matchKey(it.match) !== mk));
    } else {
      if (atCap) return;
      setItems([...items, { id: uuid(), match, note: '', marker }]);
    }
  }

  function updateItem(id: string, patch: Partial<Omit<WatchEntry, 'id'>>) {
    setItems(items.map((it) => (it.id === id ? { ...it, ...patch } : it)));
  }

  function setBy(id: string, by: 'system' | 'whType') {
    updateItem(id, { match: by === 'system' ? { by: 'system', query: '' } : { by: 'whType', code: '' } });
  }

  function removeItem(id: string) {
    setItems(items.filter((it) => it.id !== id));
  }

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  // Drag-reorder applies to the ungrouped (active) entries only; grouped lists
  // are set-and-forget, so their rows aren't draggable.
  const ungroupedIds = useMemo(() => ungrouped.map((it) => it.id), [ungrouped]);
  const draggable = ungrouped.length > 1;

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = ungroupedIds.indexOf(String(active.id));
    const to   = ungroupedIds.indexOf(String(over.id));
    if (from === -1 || to === -1) return;
    const reordered = arrayMove(ungrouped, from, to);
    setItems([...reordered, ...items.filter((it) => it.group)]);
  }

  // Row content, shared between draggable ungrouped rows and static grouped rows.
  const renderRow = (it: WatchEntry, handleProps: Record<string, unknown> | null, showDrag: boolean) => {
    const def = watchMarker(it.marker);
    const targets = matchTargets.get(it.id) ?? [];
    const onMap = targets.length > 0;
    const manual = it.match.by === 'system' || it.match.by === 'whType';
    const isDup = dupIds.has(it.id);
    return (
      <>
        <div className="watchlist__row-top">
          {showDrag && handleProps && (
            <button type="button" className="watchlist__drag-handle" {...handleProps} title={t('closest.dragToReorder')}>⠿</button>
          )}
          <span className="watchlist__marker-icon" style={{ color: def.color }} title={t(`watchMarker.${it.marker}`)}>
            <def.Icon size={16} weight="fill" />
          </span>
          <select
            className="watchlist__marker"
            value={it.marker}
            onChange={(e) => updateItem(it.id, { marker: e.target.value as WatchMarkerKind })}
            title={t(`watchMarker.${it.marker}`)}
            aria-label={t('watchlist.markerAria')}
          >
            {WATCH_MARKERS.map((m) => (
              <option key={m.kind} value={m.kind}>{t(`watchMarker.${m.kind}`)}</option>
            ))}
          </select>
          {manual ? (
            <select
              className="watchlist__by"
              value={it.match.by}
              onChange={(e) => setBy(it.id, e.target.value as 'system' | 'whType')}
              aria-label={t('watchlist.matchByAria')}
            >
              <option value="system">{t('watchlist.matchSystem')}</option>
              <option value="whType">{t('watchlist.matchWhType')}</option>
            </select>
          ) : (
            <span className="watchlist__char-label">{matchLabel(it.match)}</span>
          )}
          {onMap && (
            <button
              type="button"
              className={`watchlist__locate${expandedId === it.id ? ' watchlist__locate--open' : ''}`}
              onClick={() => locate(it.id)}
              title={targets.length > 1 ? `${t('watchlist.locate')} (${targets.length})` : t('watchlist.locate')}
              aria-label={t('watchlist.locate')}
              aria-expanded={targets.length > 1 ? expandedId === it.id : undefined}
            >
              <CrosshairIcon size={14} weight="bold" />
              {targets.length > 1 && <span className="watchlist__locate-count">{targets.length}</span>}
            </button>
          )}
          <button
            type="button"
            className="watchlist__remove"
            onClick={() => removeItem(it.id)}
            title={t('watchlist.remove')}
          >
            <TrashIcon size={14} weight="regular" />
          </button>
        </div>

        {expandedId === it.id && targets.length > 1 && (
          <div className="watchlist__matches">
            {targets.map((tgt) => (
              <button
                key={tgt.nodeId}
                type="button"
                className="watchlist__match"
                onClick={() => requestCenterOnNode(tgt.nodeId)}
              >
                <CrosshairIcon size={11} weight="bold" />
                {tgt.label}
              </button>
            ))}
          </div>
        )}

        <div className="watchlist__row-bottom">
          {it.match.by === 'system' && (
            <SystemSearchSelect
              value={it.match.query}
              onChange={(query) => updateItem(it.id, { match: { by: 'system', query } })}
              placeholder={t('watchlist.queryPlaceholder')}
              maxLength={48}
              className={`watchlist__value${isDup ? ' watchlist__value--dup' : ''}`}
              aria-invalid={isDup || undefined}
              ref={(el) => { if (el && autoFocusId === it.id) { el.focus(); setAutoFocusId(null); } }}
            />
          )}
          {it.match.by === 'whType' && (
            <div className={`watchlist__whpick${isDup ? ' watchlist__whpick--dup' : ''}`}>
              <WormholeTypePicker
                value={it.match.code}
                onChange={(code) => updateItem(it.id, { match: { by: 'whType', code } })}
              />
            </div>
          )}
          <input
            type="text"
            className="watchlist__note"
            value={it.note}
            maxLength={120}
            onChange={(e) => updateItem(it.id, { note: e.target.value })}
            placeholder={t('watchlist.notePlaceholder')}
          />
        </div>

        {isDup && (
          <div className="watchlist__dup-msg" role="alert">{t('watchlist.duplicate')}</div>
        )}
      </>
    );
  };

  return (
    <div className="watchlist">
      <div className="map-sidebar__hint">{t('watchlist.hint')}</div>

      <label className="watchlist__sound">
        <input
          type="checkbox"
          className="map-sidebar__toggle-input"
          checked={soundOn}
          onChange={(e) => setSoundOn(e.target.checked)}
        />
        <span>{t('watchlist.chimeToggle')}</span>
      </label>

      {/* Quick-add palette: tick a characteristic to drop it into the list. */}
      <div className="watchlist__quickadd">
        <div className="map-sidebar__label">{t('watchlist.quickAdd')}</div>
        <div className="watchlist__chips">
          {WATCH_CHARACTERISTICS.map((c) => {
            const active = activeKeys.has(matchKey(c.match));
            return (
              <button
                key={c.key}
                type="button"
                className={`watchlist__chip${active ? ' watchlist__chip--active' : ''}`}
                aria-pressed={active}
                onClick={() => toggleCharacteristic(c.match, c.defaultMarker)}
              >
                {c.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Ungrouped (active) entries — draggable. */}
      {ungrouped.length > 0 && (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[restrictToVerticalAxis]}
          onDragEnd={handleDragEnd}
        >
          <SortableContext items={ungroupedIds} strategy={verticalListSortingStrategy}>
            <div className="watchlist__list">
              {ungrouped.map((it) => (
                <SortableWatchRow key={it.id} id={it.id} disabled={!draggable}>
                  {({ handleProps }) => renderRow(it, handleProps, draggable)}
                </SortableWatchRow>
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}

      {/* Named lists — collapsible, set-and-forget. */}
      {[...groups.entries()].map(([name, entries]) => {
        const isCollapsed = collapsed.has(name);
        // How many entries in this group currently match a system on the map —
        // surfaced on the header so a collapsed group still shows at a glance
        // that some of its watched holes are present.
        const onMap = entries.reduce((n, it) => n + ((matchTargets.get(it.id)?.length ?? 0) > 0 ? 1 : 0), 0);
        return (
          <div className={`watchlist__group${onMap > 0 ? ' watchlist__group--onmap' : ''}`} key={name}>
            <div className="watchlist__group-head">
              <button
                type="button"
                className="watchlist__group-toggle"
                onClick={() => toggleGroupCollapsed(name)}
                aria-expanded={!isCollapsed}
              >
                <CaretDownIcon size={12} weight="bold" className={`watchlist__group-caret${isCollapsed ? ' watchlist__group-caret--collapsed' : ''}`} />
                <span className="watchlist__group-name">{name}</span>
                <span className="watchlist__group-count">{entries.length}</span>
                {onMap > 0 && (
                  <span className="watchlist__group-onmap" title={t('watchlist.groupOnMap', { count: onMap })}>
                    <CrosshairIcon size={12} weight="bold" />
                    {onMap}
                  </span>
                )}
              </button>
              <button
                type="button"
                className="watchlist__group-btn"
                onClick={() => addToGroup(name)}
                disabled={atCap}
                title={atCap ? t('watchlist.max', { count: MAX_WATCH }) : t('watchlist.addToGroup')}
              >
                <PlusIcon size={12} weight="bold" />
              </button>
              <button
                type="button"
                className="watchlist__group-btn watchlist__group-btn--del"
                onClick={() => deleteGroup(name)}
                title={t('watchlist.deleteGroup')}
              >
                <TrashIcon size={12} weight="regular" />
              </button>
            </div>
            {!isCollapsed && (
              <div className="watchlist__list">
                {entries.map((it) => (
                  <div className="watchlist__row" key={it.id}>{renderRow(it, null, false)}</div>
                ))}
              </div>
            )}
          </div>
        );
      })}

      <div className="watchlist__actions">
        <button
          type="button"
          className="map-sidebar__action"
          onClick={addManual}
          disabled={atCap}
          title={atCap ? t('watchlist.max', { count: MAX_WATCH }) : undefined}
        >
          <PlusIcon size={14} weight="bold" /> {t('watchlist.add')}
        </button>
        <button
          type="button"
          className="map-sidebar__action"
          onClick={() => setNewGroupOpen(true)}
          disabled={atCap}
          title={atCap ? t('watchlist.max', { count: MAX_WATCH }) : undefined}
        >
          <PlusIcon size={14} weight="bold" /> {t('watchlist.newGroup')}
        </button>
        <button
          type="button"
          className="map-sidebar__action"
          onClick={() => setImportOpen((o) => !o)}
          disabled={atCap && !importOpen}
        >
          <ListPlusIcon size={14} weight="bold" /> {t('watchlist.importGroup')}
        </button>
      </div>

      {newGroupOpen && (
        <PromptModal
          title={t('watchlist.newGroup')}
          placeholder={t('watchlist.groupNamePlaceholder')}
          onConfirm={(name) => { addToGroup(name); setNewGroupOpen(false); }}
          onCancel={() => setNewGroupOpen(false)}
        />
      )}

      {/* Bulk import: name a group, pick a marker, paste J-codes / system names
          (one per line or comma-separated). */}
      {importOpen && (
        <div className="watchlist__import">
          <div className="watchlist__import-head">
            <input
              type="text"
              className="watchlist__import-name"
              value={importName}
              maxLength={40}
              onChange={(e) => setImportName(e.target.value)}
              placeholder={t('watchlist.groupNamePlaceholder')}
            />
            <select
              className="watchlist__import-marker"
              value={importMarker}
              onChange={(e) => setImportMarker(e.target.value as WatchMarkerKind)}
              aria-label={t('watchlist.markerAria')}
            >
              {WATCH_MARKERS.map((m) => (
                <option key={m.kind} value={m.kind}>{t(`watchMarker.${m.kind}`)}</option>
              ))}
            </select>
          </div>
          <textarea
            className="watchlist__import-text"
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
            placeholder={t('watchlist.importPlaceholder')}
            rows={5}
            spellCheck={false}
          />
          <div className="watchlist__import-actions">
            <span className="watchlist__import-room">{t('watchlist.roomLeft', { count: room })}</span>
            <button type="button" className="sys-btn" onClick={() => setImportOpen(false)}>{t('actions.cancel')}</button>
            <button
              type="button"
              className="sys-btn sys-btn--ok"
              onClick={runImport}
              disabled={!importName.trim() || !importText.trim() || room === 0}
            >
              {t('watchlist.import')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
