import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client';
import { useMapStore } from '../../store/mapStore';
import { useCanEditContent } from '../../hooks/useCanEditContent';
import { useShareMode } from '../../context/ShareModeContext';
import { useUserSetting } from '../../hooks/useUserSetting';
import type { Anomaly, AnomType } from '../../types';
import { ConfirmModal, shouldSkipConfirm } from './ConfirmModal';
import { NotesEditor } from './NotesEditor';
import { XIcon } from '@phosphor-icons/react';
import { toast } from './Toaster';
import { duration, DASH } from '../../i18n/format';

// Cosmic anomalies don't need scanning — the probe scanner lists them at 100%
// straight away. The scanner's "group" column is "Cosmic Anomaly" (vs "Cosmic
// Signature" for sigs), so a single Ctrl+A / Ctrl+C of the whole window can be
// routed by group: this pane takes the anomalies, the signature pane takes the
// signatures (see SignaturePane's parser, which now rejects anomaly rows).
const ANOM_GROUP = 'cosmic anomaly';

const ANOM_TYPE_LABELS: Record<AnomType, string> = {
  unknown: 'Unknown',
  combat:  'Combat',
  ore:     'Ore',
  gas:     'Gas',
};

// Scanner "type" column ("Combat Site", "Ore Site", "Gas Site") → our enum.
const EVE_ANOM_TYPE: Record<string, AnomType> = {
  'combat site': 'combat',
  'ore site':    'ore',
  'gas site':    'gas',
};

interface ParsedAnom { anomId: string; anomType: AnomType; name: string; }

function parseAnomClipboard(text: string): ParsedAnom[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .flatMap((line): ParsedAnom[] => {
      const parts = line.split('\t');
      const anomId = parts[0]?.trim().toUpperCase() ?? '';
      if (!/^[A-Z]{3}-\d{3}$/.test(anomId)) return [];
      // Only rows the scanner classes as a Cosmic Anomaly — everything else
      // (signatures) is left for the signature pane.
      if ((parts[1]?.trim().toLowerCase() ?? '') !== ANOM_GROUP) return [];
      const type = parts[2]?.trim().toLowerCase() ?? '';
      const anomType = EVE_ANOM_TYPE[type] ?? 'unknown';
      const col3 = parts[3]?.trim() ?? '';
      const name = /^\d+\.?\d*%$/.test(col3) ? '' : col3;
      return [{ anomId, anomType, name }];
    });
}

type SortCol = 'anomId' | 'anomType' | 'name' | 'createdAt' | 'updatedAt';
type ColKey  = 'id' | 'type' | 'name' | 'notes' | 'created' | 'updated';

const DEFAULT_WIDTHS: Record<ColKey, number> = {
  id:      72,
  type:    108,
  name:    200,
  notes:   220,
  created: 80,
  updated: 80,
};

// Grace-period choices (seconds) offered before an overwrite-paste actually
// deletes an anomaly absent from the new scan. Mirrors the signature pane.
const OVERWRITE_DELAY_OPTIONS = [0, 5, 10, 30, 60, 120] as const;
const OVERWRITE_DELAY_DEFAULT = 10;
function formatDelay(sec: number): string {
  return sec >= 60 ? `${sec / 60}m` : `${sec}s`;
}

// Filter chips + type-select options. Reuses the sig-* type colour classes,
// which already cover combat / ore / gas / unknown.
const ANOM_TYPE_FILTER_ORDER: AnomType[] = ['combat', 'ore', 'gas', 'unknown'];
const ANOM_TYPE_OPTIONS: AnomType[] = ['combat', 'gas', 'ore', 'unknown'];

// Single module-level 1 s tick shared across every ElapsedCell instance, so the
// age/updated cells refresh without each pane driving its own per-second state
// update (which would re-render every row including its MDEditor).
let tickNow = Date.now();
const tickSubs = new Set<() => void>();
let tickTimer: ReturnType<typeof setInterval> | null = null;

function startTickIfNeeded() {
  if (tickTimer) return;
  tickTimer = setInterval(() => {
    tickNow = Date.now();
    tickSubs.forEach((fn) => fn());
  }, 1000);
}

function ElapsedCell({ iso, className }: { iso: string | undefined; className?: string }) {
  const { t } = useTranslation();
  const [, setTick] = useState(0);
  useEffect(() => {
    const fn = () => setTick((n) => n + 1);
    tickSubs.add(fn);
    startTickIfNeeded();
    return () => {
      tickSubs.delete(fn);
      if (tickSubs.size === 0 && tickTimer) {
        clearInterval(tickTimer);
        tickTimer = null;
      }
    };
  }, []);
  const text = iso
    ? duration(t, Math.floor((tickNow - new Date(iso).getTime()) / 1000))
    : DASH;
  return <td className={className}>{text}</td>;
}

export function AnomalyPane({ systemId }: { systemId: string }) {
  const { t } = useTranslation();
  const anomTypeLabel = (type: AnomType) =>
    type === 'unknown' ? t('anomType.unknown') : ANOM_TYPE_LABELS[type];
  const activeMapId     = useMapStore((s) => s.activeMapId);
  const map             = useMapStore((s) => s.map);
  const currentSystemId = useMapStore((s) => s.currentSystemId);
  const canEdit         = useCanEditContent();
  const { isShareMode } = useShareMode();

  const [anoms, setAnoms]         = useState<Anomaly[]>([]);
  const [selected, setSelected]   = useState<Set<string>>(new Set());
  const [pendingAction, setPendingAction] = useState<{ message: string; fn: () => void; confirmLabel?: string; showDontAskAgain?: boolean } | null>(null);
  const [sortCol, setSortCol]     = useState<SortCol | null>('anomId');
  const [sortDir, setSortDir]     = useState<'asc' | 'desc'>('asc');
  const [typeFilter, setTypeFilter] = useState<Set<AnomType>>(new Set());

  const toggleTypeFilter = (type: AnomType) => {
    setTypeFilter((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  };

  const [savedColWidths, setColWidths] = useUserSetting<Partial<Record<ColKey, number>>>(
    'nexum.anomPane.colWidths',
    {},
  );
  const colWidths = useMemo(
    () => ({ ...DEFAULT_WIDTHS, ...savedColWidths }) as Record<ColKey, number>,
    [savedColWidths],
  );

  const pendingUpdates = useRef<Map<string, Partial<Anomaly>>>(new Map());
  const debounceTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const anomsRef       = useRef<Anomaly[]>([]);
  useEffect(() => { anomsRef.current = anoms; }, [anoms]);

  // Overwrite-on-paste: when on (or Shift held), a paste also removes anomalies
  // whose ID is absent from the pasted scan. Off by default (additive).
  const [overwriteOnPaste, setOverwriteOnPaste] = useUserSetting<boolean>(
    'nexum.anomPane.overwriteOnPaste',
    false,
  );
  const shiftHeldRef = useRef(false);

  const [overwriteDelay, setOverwriteDelay] = useUserSetting<number>(
    'nexum.anomPane.overwriteDelay',
    OVERWRITE_DELAY_DEFAULT,
  );

  // Anomalies pending delayed removal, plus their timers.
  const [removing, setRemoving] = useState<Set<string>>(new Set());
  const removalTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => () => {
    for (const tm of removalTimers.current.values()) clearTimeout(tm);
    removalTimers.current.clear();
  }, []);

  useEffect(() => {
    const onDown = (e: KeyboardEvent) => { if (e.key === 'Shift') shiftHeldRef.current = true; };
    const onUp   = (e: KeyboardEvent) => { if (e.key === 'Shift') shiftHeldRef.current = false; };
    const reset  = () => { shiftHeldRef.current = false; };
    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    window.addEventListener('blur', reset);
    return () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
      window.removeEventListener('blur', reset);
    };
  }, []);

  // Bumped when another client changes this system's anomalies (live sync).
  const anomRev = useMapStore((s) => s.anomRev[systemId] ?? 0);

  useEffect(() => {
    if (!activeMapId) return;
    for (const tm of removalTimers.current.values()) clearTimeout(tm);
    removalTimers.current.clear();
    setRemoving(new Set());
    setAnoms([]);
    setSelected(new Set());

    // Share viewers don't get anomalies embedded in the payload yet, and the
    // /api/maps route isn't reachable on the placeholder "shared" mapId — the
    // panel is hidden in share mode (see SystemPanel), so just bail.
    if (isShareMode) return;

    api<Anomaly[]>(`/api/maps/${activeMapId}/systems/${systemId}/anomalies`)
      .then(setAnoms)
      .catch(() => toast.error(t('anomalies.loadFailed')));
  }, [activeMapId, systemId, isShareMode]);

  // Live sync: re-fetch in place when a remote client changes this system's
  // anomalies. Guarded so it doesn't fire on initial mount (rev starts at 0).
  useEffect(() => {
    if (!activeMapId || isShareMode || anomRev === 0) return;
    api<Anomaly[]>(`/api/maps/${activeMapId}/systems/${systemId}/anomalies`)
      .then(setAnoms)
      .catch(() => {});
  }, [anomRev, activeMapId, systemId, isShareMode]);

  const updateAnom = (id: string, updates: Partial<Anomaly>) => {
    const withTs = { ...updates, updatedAt: new Date().toISOString() };
    setAnoms((prev) => prev.map((a) => a.id === id ? { ...a, ...withTs } : a));

    pendingUpdates.current.set(id, { ...(pendingUpdates.current.get(id) ?? {}), ...updates });
    clearTimeout(debounceTimers.current.get(id));
    debounceTimers.current.set(id, setTimeout(async () => {
      const payload = pendingUpdates.current.get(id);
      if (!payload || !activeMapId) return;
      pendingUpdates.current.delete(id);
      api(`/api/maps/${activeMapId}/systems/${systemId}/anomalies/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }).catch(() => toast.error(t('anomalies.saveFailed')));
    }, 500));
  };

  const clearRemoval = (id: string) => {
    const tm = removalTimers.current.get(id);
    if (tm) { clearTimeout(tm); removalTimers.current.delete(id); }
    setRemoving((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev); next.delete(id); return next;
    });
  };

  const deleteAnom = (id: string) => {
    if (!activeMapId) return;
    clearRemoval(id);
    setAnoms((prev) => prev.filter((a) => a.id !== id));
    setSelected((prev) => { const next = new Set(prev); next.delete(id); return next; });
    api(`/api/maps/${activeMapId}/systems/${systemId}/anomalies/${id}`, { method: 'DELETE' })
      .catch(() => toast.error(t('anomalies.deleteFailed')));
  };

  const scheduleRemoval = (id: string, delaySec: number) => {
    const existing = removalTimers.current.get(id);
    if (existing) clearTimeout(existing);
    if (delaySec <= 0) {
      removalTimers.current.delete(id);
      deleteAnom(id);
      return;
    }
    setRemoving((prev) => { const next = new Set(prev); next.add(id); return next; });
    const tm = setTimeout(() => deleteAnom(id), delaySec * 1000);
    removalTimers.current.set(id, tm);
  };

  const processPaste = useCallback(async (parsed: ParsedAnom[], overwrite: boolean, delaySec: number) => {
    if (!activeMapId) return;
    const existing = anomsRef.current;
    const toUpdate: { id: string; updates: Partial<Anomaly> }[] = [];
    const toCreate: ParsedAnom[] = [];

    for (const p of parsed) {
      const match = existing.find((a) => a.anomId === p.anomId);
      if (match) {
        const updates: Partial<Anomaly> = {};
        if (p.anomType !== 'unknown') updates.anomType = p.anomType;
        if (p.name) updates.name = p.name;
        toUpdate.push({ id: match.id, updates });
      } else {
        toCreate.push(p);
      }
    }

    // Overwrite mode: anomalies absent from the new scan are flagged for
    // delayed removal (an anomaly that reappears has its removal cancelled).
    // Blank/manually-added rows (no ID) are left alone.
    if (overwrite) {
      const pastedIds = new Set(parsed.map((p) => p.anomId));
      for (const a of existing) {
        if (!a.anomId) continue;
        if (pastedIds.has(a.anomId)) clearRemoval(a.id);
        else scheduleRemoval(a.id, delaySec);
      }
    }

    for (const { id, updates } of toUpdate) updateAnom(id, updates);

    const created = (await Promise.all(
      toCreate.map((p) =>
        api<Anomaly>(
          `/api/maps/${activeMapId}/systems/${systemId}/anomalies`,
          { method: 'POST', body: JSON.stringify({ anomId: p.anomId, anomType: p.anomType, name: p.name }) },
        ).catch(() => null),
      ),
    )).filter((a): a is Anomaly => a !== null);

    setAnoms((prev) => [...prev, ...created].sort((a, b) => a.anomId.localeCompare(b.anomId)));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeMapId, systemId]);

  useEffect(() => {
    if (!activeMapId) return;

    const handlePaste = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement;
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable
      ) return;

      const text = e.clipboardData?.getData('text') ?? '';
      const parsed = parseAnomClipboard(text);
      if (parsed.length === 0) return;

      e.preventDefault();

      const overwrite = overwriteOnPaste || shiftHeldRef.current;
      const delaySec = overwriteDelay;

      if (currentSystemId && currentSystemId !== systemId) {
        const currentName  = map.systems.find((s) => s.id === currentSystemId)?.name  ?? 'unknown';
        const selectedName = map.systems.find((s) => s.id === systemId)?.name ?? 'unknown';
        setPendingAction({
          message: t('anomalies.pasteDifferentSystem', { current: currentName, selected: selectedName }),
          fn: () => processPaste(parsed, overwrite, delaySec),
          confirmLabel: t('actions.ok'),
          showDontAskAgain: false,
        });
        return;
      }

      processPaste(parsed, overwrite, delaySec);
    };

    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, [activeMapId, systemId, currentSystemId, map.systems, processPaste, overwriteOnPaste, overwriteDelay, t]);

  const addAnom = async () => {
    if (!activeMapId) return;
    const anom = await api<Anomaly>(
      `/api/maps/${activeMapId}/systems/${systemId}/anomalies`,
      { method: 'POST', body: JSON.stringify({}) },
    );
    setAnoms((prev) => [...prev, anom]);
  };

  const confirm = (message: string, action: () => void) => {
    if (shouldSkipConfirm()) { action(); return; }
    setPendingAction({ message, fn: action });
  };

  const deleteSelected = () => confirm(
    t('anomalies.deleteSelectedConfirm', { count: selected.size }),
    () => { for (const id of selected) deleteAnom(id); },
  );

  const deleteAll = () => confirm(
    t('anomalies.deleteAllConfirm', { count: anomsRef.current.length }),
    () => { for (const a of anomsRef.current) deleteAnom(a.id); },
  );

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const allChecked = anoms.length > 0 && selected.size === anoms.length;
  const someChecked = selected.size > 0 && !allChecked;
  const toggleAll = () => setSelected(allChecked ? new Set() : new Set(anoms.map((a) => a.id)));

  const handleSort = (col: SortCol) => {
    if (sortCol === col) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortCol(col);
      setSortDir('asc');
    }
  };

  const sortedAnoms = useMemo(() => {
    const base = typeFilter.size ? anoms.filter((a) => typeFilter.has(a.anomType)) : anoms;
    if (!sortCol) return base;
    return [...base].sort((a, b) => {
      const av = (a[sortCol] ?? '').toLowerCase();
      const bv = (b[sortCol] ?? '').toLowerCase();
      const cmp = av.localeCompare(bv);
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [anoms, sortCol, sortDir, typeFilter]);

  const startResize = (col: ColKey, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startWidth = colWidths[col];
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMove = (ev: MouseEvent) => {
      const newWidth = Math.max(40, startWidth + ev.clientX - startX);
      setColWidths((prev) => ({ ...prev, [col]: newWidth }));
    };

    const onUp = () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  const sortInd = (col: SortCol) =>
    sortCol === col ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '';

  return (
    <>
    {pendingAction && (
      <ConfirmModal
        message={pendingAction.message}
        onConfirm={() => { pendingAction.fn(); setPendingAction(null); }}
        onCancel={() => setPendingAction(null)}
        confirmLabel={pendingAction.confirmLabel}
        showDontAskAgain={pendingAction.showDontAskAgain}
      />
    )}
    <div className="sig-pane">
      {anoms.length === 0 && (
        <p className="sig-pane__hint">{t('anomalies.pasteHint')}</p>
      )}
      {canEdit && (
        <div className="sig-pane__toolbar">
          <button className="icon-btn" onClick={addAnom} title={t('anomalies.addAnomaly')}>{t('anomalies.addAnomaly')}</button>
          <label
            className={`sig-overwrite-toggle${overwriteOnPaste ? ' sig-overwrite-toggle--active' : ''}`}
            data-tooltip={t('anomalies.overwriteTooltip')}
          >
            <input
              type="checkbox"
              className="map-sidebar__toggle-input"
              checked={overwriteOnPaste}
              onChange={(e) => setOverwriteOnPaste(e.target.checked)}
            />
            <span>{t('anomalies.overwriteToggle')}</span>
          </label>
          <select
            className="sig-toolbar-btn"
            value={overwriteDelay}
            onChange={(e) => setOverwriteDelay(Number(e.target.value))}
            aria-label={t('anomalies.removeDelayLabel')}
            data-tooltip={t('anomalies.removeDelayTooltip')}
          >
            {OVERWRITE_DELAY_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {s === 0 ? t('anomalies.removeDelayInstant') : formatDelay(s)}
              </option>
            ))}
          </select>
          {selected.size > 0 && (
            <button className="sig-toolbar-btn sig-toolbar-btn--danger" onClick={deleteSelected}>
              {t('anomalies.deleteSelected', { count: selected.size })}
            </button>
          )}
          {anoms.length > 0 && (
            <button className="sig-toolbar-btn sig-toolbar-btn--danger" onClick={deleteAll}>
              {t('anomalies.deleteAll')}
            </button>
          )}
        </div>
      )}

      {anoms.length > 0 && (
        <div className="sig-pane__filter" role="group" aria-label={t('anomalies.filterLabel')}>
          {ANOM_TYPE_FILTER_ORDER.map((type) => (
            <button
              key={type}
              type="button"
              className={`sig-filter-chip sig-filter-chip--${type}${typeFilter.has(type) ? ' sig-filter-chip--active' : ''}`}
              aria-pressed={typeFilter.has(type)}
              onClick={() => toggleTypeFilter(type)}
            >
              {t(`anomType.${type}`)}
            </button>
          ))}
          {typeFilter.size > 0 && (
            <button type="button" className="sig-filter-clear" onClick={() => setTypeFilter(new Set())}>
              {t('anomalies.filterClear')}
            </button>
          )}
        </div>
      )}

      {anoms.length === 0 ? (
        <div className="sig-pane__empty">{t('anomalies.empty')}</div>
      ) : sortedAnoms.length === 0 ? (
        <div className="sig-pane__empty">{t('anomalies.noMatchFilter')}</div>
      ) : (
        <div className="sig-table-wrap">
        <table className="sig-table">
          <colgroup>
            <col className="sig-col--check" />
            <col style={{ width: colWidths.id }} />
            <col style={{ width: colWidths.type }} />
            <col style={{ width: colWidths.name }} />
            <col style={{ width: colWidths.notes }} />
            <col style={{ width: colWidths.created }} />
            <col style={{ width: colWidths.updated }} />
            <col className="sig-col--actions" />
          </colgroup>
          <thead>
            <tr>
              <th>
                <input
                  type="checkbox"
                  className="sig-checkbox"
                  checked={allChecked}
                  ref={(el) => { if (el) el.indeterminate = someChecked; }}
                  onChange={toggleAll}
                />
              </th>
              <th className="sig-th sig-th--sortable" onClick={() => handleSort('anomId')}>
                {t('anomalies.colId')}{sortInd('anomId')}
                <div className="sig-th__resize" onMouseDown={(e) => startResize('id', e)} />
              </th>
              <th className="sig-th sig-th--sortable" onClick={() => handleSort('anomType')}>
                {t('anomalies.colType')}{sortInd('anomType')}
                <div className="sig-th__resize" onMouseDown={(e) => startResize('type', e)} />
              </th>
              <th className="sig-th sig-th--sortable" onClick={() => handleSort('name')}>
                {t('anomalies.colName')}{sortInd('name')}
                <div className="sig-th__resize" onMouseDown={(e) => startResize('name', e)} />
              </th>
              <th className="sig-th">
                {t('anomalies.colNotes')}
                <div className="sig-th__resize" onMouseDown={(e) => startResize('notes', e)} />
              </th>
              <th className="sig-th sig-th--sortable sig-th--time" onClick={() => handleSort('createdAt')}>
                {t('anomalies.colAge')}{sortInd('createdAt')}
                <div className="sig-th__resize" onMouseDown={(e) => startResize('created', e)} />
              </th>
              <th className="sig-th sig-th--sortable sig-th--time" onClick={() => handleSort('updatedAt')}>
                {t('anomalies.colUpdated')}{sortInd('updatedAt')}
                <div className="sig-th__resize" onMouseDown={(e) => startResize('updated', e)} />
              </th>
              <th className="sig-cell--actions" />
            </tr>
          </thead>
          <tbody>
            {sortedAnoms.map((anom) => (
              <tr
                key={anom.id}
                className={`${selected.has(anom.id) ? 'sig-row--selected' : ''} ${anom.anomType === 'unknown' ? 'sig-row--unknown' : ''} ${removing.has(anom.id) ? 'sig-row--removing' : ''}`}
                style={removing.has(anom.id) && overwriteDelay > 0 ? { animationDuration: `${overwriteDelay}s` } : undefined}
              >
                <td>
                  <input
                    type="checkbox"
                    className="sig-checkbox"
                    checked={selected.has(anom.id)}
                    onChange={() => toggleSelect(anom.id)}
                  />
                </td>
                <td>
                  <input
                    className="sig-input sig-input--id"
                    value={anom.anomId}
                    onChange={(e) => updateAnom(anom.id, { anomId: e.target.value.toUpperCase() })}
                    placeholder="ABC-123"
                    maxLength={7}
                    spellCheck={false}
                  />
                </td>
                <td>
                  <select
                    className={`sig-select sig-select--type sig-select--type-${anom.anomType}`}
                    value={anom.anomType}
                    onChange={(e) => updateAnom(anom.id, { anomType: e.target.value as AnomType })}
                  >
                    {ANOM_TYPE_OPTIONS.map((at) => (
                      <option key={at} value={at}>{anomTypeLabel(at)}</option>
                    ))}
                  </select>
                </td>
                <td>
                  <input
                    className="sig-input"
                    value={anom.name}
                    onChange={(e) => updateAnom(anom.id, { name: e.target.value })}
                    placeholder={t('anomalies.namePlaceholder')}
                  />
                </td>
                <td className="sig-notes-cell">
                  <NotesEditor
                    value={anom.notes}
                    onChange={(v) => updateAnom(anom.id, { notes: v })}
                    compact
                    readOnly={!canEdit}
                  />
                </td>
                <ElapsedCell iso={anom.createdAt} className="sig-td--time" />
                <ElapsedCell iso={anom.updatedAt} className="sig-td--time sig-td--updated" />
                <td className="sig-cell--actions">
                  {canEdit && (
                    <button
                      className="icon-btn icon-btn--danger"
                      onClick={() => deleteAnom(anom.id)}
                      title={t('actions.delete')}
                    ><XIcon size={12} weight="bold" /></button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
    </div>
    </>
  );
}
