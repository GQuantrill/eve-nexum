import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api/client';
import { useMapStore } from '../../store/mapStore';
import type { Signature, SigType } from '../../types';
import { ConfirmModal, shouldSkipConfirm } from './ConfirmModal';
import { NotesEditor } from './NotesEditor';
import { WormholeTypePicker } from './WormholeTypePicker';
import { LeadsToDropdown } from './LeadsToDropdown';

const SIG_TYPE_LABELS: Record<SigType, string> = {
  unknown:  'Unknown',
  wormhole: 'Wormhole',
  data:     'Data',
  relic:    'Relic',
  combat:   'Combat',
  gas:      'Gas',
  ore:      'Ore',
};

const EVE_GROUP_TO_TYPE: Record<string, SigType> = {
  'data site':   'data',
  'gas site':    'gas',
  'relic site':  'relic',
  'combat site': 'combat',
  'ore site':    'ore',
  'wormhole':    'wormhole',
};

interface ParsedSig { sigId: string; sigType: SigType; name: string; }

function parseSigClipboard(text: string): ParsedSig[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .flatMap((line): ParsedSig[] => {
      const parts = line.split('\t');
      const sigId = parts[0]?.trim().toUpperCase() ?? '';
      if (!/^[A-Z]{3}-\d{3}$/.test(sigId)) return [];
      const group = parts[2]?.trim() ?? '';
      const sigType = EVE_GROUP_TO_TYPE[group.toLowerCase()] ?? 'unknown';
      const col3 = parts[3]?.trim() ?? '';
      const name = /^\d+\.?\d*%$/.test(col3) ? '' : col3;
      return [{ sigId, sigType, name }];
    });
}

type SortCol = 'sigId' | 'sigType' | 'whType' | 'whLeadsTo' | 'name' | 'createdAt' | 'updatedAt';
type ColKey  = 'id' | 'type' | 'whtype' | 'leadsto' | 'name' | 'notes' | 'created' | 'updated';

const DEFAULT_WIDTHS: Record<ColKey, number> = {
  id:      72,
  type:    108,
  whtype:  170,
  leadsto: 105,
  name:    140,
  notes:   220,
  created: 80,
  updated: 80,
};

function elapsed(isoString: string | undefined, now: number): string {
  if (!isoString) return '—';
  const diff = Math.floor((now - new Date(isoString).getTime()) / 1000);
  if (diff < 0) return '0s';
  if (diff < 60) return `${diff}s`;
  const m = Math.floor(diff / 60);
  const s = diff % 60;
  if (m < 60) return `${m}m ${s < 10 ? '0' : ''}${s}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h ${rm < 10 ? '0' : ''}${rm}m`;
}

export function SignaturePane({ systemId }: { systemId: string }) {
  const activeMapId     = useMapStore((s) => s.activeMapId);
  const map             = useMapStore((s) => s.map);
  const currentSystemId = useMapStore((s) => s.currentSystemId);

  const systemStatics = useMemo(
    () => map.systems.find((sys) => sys.id === systemId)?.statics ?? [],
    [map.systems, systemId],
  );

  const connectedSystems = useMemo(() => {
    const conns = map.connections.filter(
      (c) => c.sourceId === systemId || c.targetId === systemId,
    );
    return conns.flatMap((c) => {
      const otherId = c.sourceId === systemId ? c.targetId : c.sourceId;
      const sys = map.systems.find((m) => m.id === otherId);
      return sys ? [{ id: sys.id, name: sys.name, systemClass: sys.systemClass }] : [];
    });
  }, [map.connections, map.systems, systemId]);

  const [sigs, setSigs]               = useState<Signature[]>([]);
  const [selected, setSelected]       = useState<Set<string>>(new Set());
  const [pendingAction, setPendingAction] = useState<{ message: string; fn: () => void } | null>(null);
  const [sortCol, setSortCol]         = useState<SortCol | null>(null);
  const [sortDir, setSortDir]         = useState<'asc' | 'desc'>('asc');
  const [colWidths, setColWidths]     = useState<Record<ColKey, number>>(DEFAULT_WIDTHS);
  const [now, setNow]                 = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const pendingUpdates = useRef<Map<string, Partial<Signature>>>(new Map());
  const debounceTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const sigsRef        = useRef<Signature[]>([]);
  sigsRef.current = sigs;

  useEffect(() => {
    if (!activeMapId) return;
    setSigs([]);
    setSelected(new Set());
    api<Signature[]>(`/api/maps/${activeMapId}/systems/${systemId}/signatures`)
      .then(setSigs)
      .catch(() => {});
  }, [activeMapId, systemId]);

  const processPaste = useCallback(async (parsed: ParsedSig[]) => {
    if (!activeMapId) return;
    const existing = sigsRef.current;
    const toUpdate: { id: string; updates: Partial<Signature> }[] = [];
    const toCreate: ParsedSig[] = [];

    for (const p of parsed) {
      const match = existing.find((s) => s.sigId === p.sigId);
      if (match) {
        const updates: Partial<Signature> = {};
        if (p.sigType !== 'unknown') updates.sigType = p.sigType;
        if (p.name) updates.name = p.name;
        toUpdate.push({ id: match.id, updates });
      } else {
        toCreate.push(p);
      }
    }

    for (const { id, updates } of toUpdate) updateSig(id, updates);

    for (const p of toCreate) {
      try {
        const sig = await api<Signature>(
          `/api/maps/${activeMapId}/systems/${systemId}/signatures`,
          { method: 'POST', body: JSON.stringify({ sigId: p.sigId, sigType: p.sigType, name: p.name }) },
        );
        setSigs((prev) => [...prev, sig]);
      } catch { /* ignore individual failures */ }
    }
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
      const parsed = parseSigClipboard(text);
      if (parsed.length === 0) return;

      e.preventDefault();

      // Warn if the character is in a different system than the one being edited
      if (currentSystemId && currentSystemId !== systemId) {
        const currentName  = map.systems.find((s) => s.id === currentSystemId)?.name  ?? 'unknown';
        const selectedName = map.systems.find((s) => s.id === systemId)?.name ?? 'unknown';
        setPendingAction({
          message: `Your character is currently in ${currentName}, but you are pasting signatures into ${selectedName}. Continue?`,
          fn: () => processPaste(parsed),
        });
        return;
      }

      processPaste(parsed);
    };

    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, [activeMapId, systemId, currentSystemId, map.systems, processPaste]);

  const addSig = async () => {
    if (!activeMapId) return;
    const sig = await api<Signature>(
      `/api/maps/${activeMapId}/systems/${systemId}/signatures`,
      { method: 'POST', body: JSON.stringify({}) },
    );
    setSigs((prev) => [...prev, sig]);
  };

  const updateSig = (id: string, updates: Partial<Signature>) => {
    const withTs = { ...updates, updatedAt: new Date().toISOString() };
    setSigs((prev) => prev.map((s) => s.id === id ? { ...s, ...withTs } : s));
    pendingUpdates.current.set(id, { ...(pendingUpdates.current.get(id) ?? {}), ...updates });
    clearTimeout(debounceTimers.current.get(id));
    debounceTimers.current.set(id, setTimeout(async () => {
      const payload = pendingUpdates.current.get(id);
      if (!payload || !activeMapId) return;
      pendingUpdates.current.delete(id);
      api(`/api/maps/${activeMapId}/systems/${systemId}/signatures/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }).catch(console.error);
    }, 500));
  };

  const deleteSig = (id: string) => {
    if (!activeMapId) return;
    setSigs((prev) => prev.filter((s) => s.id !== id));
    setSelected((prev) => { const next = new Set(prev); next.delete(id); return next; });
    api(`/api/maps/${activeMapId}/systems/${systemId}/signatures/${id}`, { method: 'DELETE' })
      .catch(console.error);
  };

  const confirm = (message: string, action: () => void) => {
    if (shouldSkipConfirm()) { action(); return; }
    setPendingAction({ message, fn: action });
  };

  const deleteSelected = () => confirm(
    `Delete ${selected.size} selected signature${selected.size !== 1 ? 's' : ''}?`,
    () => { for (const id of selected) deleteSig(id); },
  );

  const deleteAll = () => confirm(
    `Delete all ${sigsRef.current.length} signature${sigsRef.current.length !== 1 ? 's' : ''}?`,
    () => { for (const sig of sigsRef.current) deleteSig(sig.id); },
  );

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const allChecked = sigs.length > 0 && selected.size === sigs.length;
  const someChecked = selected.size > 0 && !allChecked;
  const toggleAll = () => setSelected(allChecked ? new Set() : new Set(sigs.map((s) => s.id)));

  const handleSort = (col: SortCol) => {
    if (sortCol === col) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortCol(col);
      setSortDir('asc');
    }
  };

  const sortedSigs = useMemo(() => {
    if (!sortCol) return sigs;
    return [...sigs].sort((a, b) => {
      const av = (a[sortCol] ?? '').toLowerCase();
      const bv = (b[sortCol] ?? '').toLowerCase();
      const cmp = av.localeCompare(bv);
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [sigs, sortCol, sortDir]);

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
      />
    )}
    <div className="sig-pane">
      <p className="sig-pane__hint">You can copy and paste signatures directly from the Probe scanner in Eve. To do this, open your probe scanner.  Press control A to select them all, then control C to copy.  Use control V to paste them here</p>
      <div className="sig-pane__toolbar">
        <button className="icon-btn" onClick={addSig} title="Add signature">Add signature</button>
        {selected.size > 0 && (
          <button className="sig-toolbar-btn sig-toolbar-btn--danger" onClick={deleteSelected}>
            Delete selected ({selected.size})
          </button>
        )}
        {sigs.length > 0 && (
          <button className="sig-toolbar-btn sig-toolbar-btn--danger" onClick={deleteAll}>
            Delete all
          </button>
        )}
      </div>

      {sigs.length === 0 ? (
        <div className="sig-pane__empty">No signatures scanned — paste from probe scanner to import</div>
      ) : (
        <table className="sig-table">
          <colgroup>
            <col className="sig-col--check" />
            <col style={{ width: colWidths.id }} />
            <col style={{ width: colWidths.type }} />
            <col style={{ width: colWidths.whtype }} className="sig-col--whtype" />
            <col style={{ width: colWidths.leadsto }} />
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
              <th className="sig-th sig-th--sortable" onClick={() => handleSort('sigId')}>
                ID{sortInd('sigId')}
                <div className="sig-th__resize" onMouseDown={(e) => startResize('id', e)} />
              </th>
              <th className="sig-th sig-th--sortable" onClick={() => handleSort('sigType')}>
                Type{sortInd('sigType')}
                <div className="sig-th__resize" onMouseDown={(e) => startResize('type', e)} />
              </th>
              <th className="sig-th sig-th--sortable" onClick={() => handleSort('whType')}>
                WH{sortInd('whType')}
                <div className="sig-th__resize" onMouseDown={(e) => startResize('whtype', e)} />
              </th>
              <th className="sig-th sig-th--sortable" onClick={() => handleSort('whLeadsTo')}>
                Leads To{sortInd('whLeadsTo')}
                <div className="sig-th__resize" onMouseDown={(e) => startResize('leadsto', e)} />
              </th>
              <th className="sig-th sig-th--sortable" onClick={() => handleSort('name')}>
                Name{sortInd('name')}
                <div className="sig-th__resize" onMouseDown={(e) => startResize('name', e)} />
              </th>
              <th className="sig-th">
                Notes
                <div className="sig-th__resize" onMouseDown={(e) => startResize('notes', e)} />
              </th>
              <th className="sig-th sig-th--sortable sig-th--time" onClick={() => handleSort('createdAt')}>
                Age{sortInd('createdAt')}
                <div className="sig-th__resize" onMouseDown={(e) => startResize('created', e)} />
              </th>
              <th className="sig-th sig-th--sortable sig-th--time" onClick={() => handleSort('updatedAt')}>
                Updated{sortInd('updatedAt')}
                <div className="sig-th__resize" onMouseDown={(e) => startResize('updated', e)} />
              </th>
              <th />
            </tr>
          </thead>
          <tbody>
            {sortedSigs.map((sig) => (
              <tr key={sig.id} className={selected.has(sig.id) ? 'sig-row--selected' : ''}>
                <td>
                  <input
                    type="checkbox"
                    className="sig-checkbox"
                    checked={selected.has(sig.id)}
                    onChange={() => toggleSelect(sig.id)}
                  />
                </td>
                <td>
                  <input
                    className="sig-input sig-input--id"
                    value={sig.sigId}
                    onChange={(e) => updateSig(sig.id, { sigId: e.target.value.toUpperCase() })}
                    placeholder="ABC-123"
                    maxLength={7}
                    spellCheck={false}
                  />
                </td>
                <td>
                  <select
                    className={`sig-select sig-select--type sig-select--type-${sig.sigType}`}
                    value={sig.sigType}
                    onChange={(e) => updateSig(sig.id, { sigType: e.target.value as SigType })}
                  >
                    {(Object.keys(SIG_TYPE_LABELS) as SigType[]).map((t) => (
                      <option key={t} value={t}>{SIG_TYPE_LABELS[t]}</option>
                    ))}
                  </select>
                </td>
                <td className="sig-td--wh">
                  {sig.sigType === 'wormhole' && (
                    <WormholeTypePicker
                      value={sig.whType}
                      statics={systemStatics}
                      onChange={(whType, leadsTo) => updateSig(sig.id, {
                        whType,
                        ...(!sig.whLeadsTo && leadsTo ? { whLeadsTo: leadsTo } : {}),
                      })}
                    />
                  )}
                </td>
                <td className="sig-td--wh">
                  {sig.sigType === 'wormhole' && (
                    <LeadsToDropdown
                      value={sig.whLeadsTo}
                      connectedSystems={connectedSystems}
                      onChange={(leadsTo) => updateSig(sig.id, { whLeadsTo: leadsTo })}
                    />
                  )}
                </td>
                <td>
                  <input
                    className="sig-input"
                    value={sig.name}
                    onChange={(e) => updateSig(sig.id, { name: e.target.value })}
                    placeholder="Site name"
                  />
                </td>
                <td className="sig-notes-cell">
                  <NotesEditor
                    value={sig.notes}
                    onChange={(v) => updateSig(sig.id, { notes: v })}
                    compact
                  />
                </td>
                <td className="sig-td--time">{elapsed(sig.createdAt, now)}</td>
                <td className="sig-td--time sig-td--updated">{elapsed(sig.updatedAt, now)}</td>
                <td>
                  <button
                    className="icon-btn icon-btn--danger"
                    onClick={() => deleteSig(sig.id)}
                    title="Delete"
                  >✕</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
    </>
  );
}
