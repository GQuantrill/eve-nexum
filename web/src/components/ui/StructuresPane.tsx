import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../../api/client';
import { useMapStore } from '../../store/mapStore';
import type { Structure, StructureType } from '../../types';
import { NotesEditor } from './NotesEditor';
import { ConfirmModal, shouldSkipConfirm } from './ConfirmModal';
import { ContextMenu } from './ContextMenu';
import { setDestination, addWaypoint } from '../../api/waypoint';
import { toast } from './Toaster';
import { useCanEditContent } from '../../hooks/useCanEditContent';
import { useStandings } from '../../hooks/useStandings';

const STRUCTURE_TYPE_LABELS: Record<StructureType, string> = {
  unknown:   'Unknown',
  astrahus:  'Astrahus',
  fortizar:  'Fortizar',
  keepstar:  'Keepstar',
  raitaru:   'Raitaru',
  azbel:     'Azbel',
  sotiyo:    'Sotiyo',
  athanor:   'Athanor',
  tatara:    'Tatara',
  ansiblex:  'Ansiblex',
  pharolynx: 'Pharolynx',
  tenebrex:  'Tenebrex',
};

const PASTE_TYPE_MAP: Partial<Record<string, StructureType>> = {
  'astrahus':  'astrahus',
  'fortizar':  'fortizar',
  'keepstar':  'keepstar',
  'raitaru':   'raitaru',
  'azbel':     'azbel',
  'sotiyo':    'sotiyo',
  'athanor':   'athanor',
  'tatara':    'tatara',
  'ansiblex jump gate': 'ansiblex',
  'ansiblex':  'ansiblex',
  'pharolynx cyno beacon': 'pharolynx',
  'pharolynx': 'pharolynx',
  'tenebrex cyno jammer': 'tenebrex',
  'tenebrex':  'tenebrex',
};

interface ParsedStructure { eveId: number; name: string; structureType: StructureType; }

function parseStructureClipboard(text: string): ParsedStructure[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .flatMap((line): ParsedStructure[] => {
      const parts = line.split('\t');
      if (parts.length < 3) return [];
      const eveId = parseInt(parts[0]?.trim() ?? '', 10);
      if (isNaN(eveId)) return [];
      const name = parts[1]?.trim() ?? '';
      const typeStr = parts[2]?.trim().toLowerCase() ?? '';
      const structureType = PASTE_TYPE_MAP[typeStr];
      if (!structureType) return [];
      return [{ eveId, name, structureType }];
    });
}

interface KnownStructure {
  structureId: string;
  systemId:    number;
  ownerCorpId: number | null;
  name:        string;
  typeId:      number | null;
  source:      'corp-esi' | 'public-dataset';
  lastSeenAt:  string;
}

export function StructuresPane({ systemId }: { systemId: string }) {
  const activeMapId = useMapStore((s) => s.activeMapId);
  const canEdit     = useCanEditContent();
  const standings   = useStandings();
  // Look up the EVE solar_system_id for this map system — known-structures
  // are keyed by that, not by the map-system UUID.
  const eveSystemId = useMapStore((s) => s.map.systems.find((sys) => sys.id === systemId)?.eveSystemId ?? null);
  const [structures, setStructures] = useState<Structure[]>([]);
  const [knownStructures, setKnownStructures] = useState<KnownStructure[]>([]);
  const [pendingAction, setPendingAction] = useState<{ message: string; fn: () => void } | null>(null);
  const [ctx, setCtx] = useState<{ x: number; y: number; structure: Structure } | null>(null);

  const pendingUpdates = useRef<Map<string, Partial<Structure>>>(new Map());
  const debounceTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const structuresRef = useRef<Structure[]>([]);
  structuresRef.current = structures;

  useEffect(() => {
    if (!activeMapId) return;
    setStructures([]);
    api<Structure[]>(`/api/maps/${activeMapId}/systems/${systemId}/structures`)
      .then(setStructures)
      .catch(() => toast.error('Failed to load structures'));
  }, [activeMapId, systemId]);

  // Pull cached known structures (corp-ESI + public-dataset). Filtered by
  // eveSystemId, then deduped against the user's manual entries by eve_id
  // at render time so we don't show the same citadel twice.
  useEffect(() => {
    if (!eveSystemId) { setKnownStructures([]); return; }
    api<KnownStructure[]>(`/api/known-structures/${eveSystemId}`)
      .then(setKnownStructures)
      .catch(() => setKnownStructures([]));
  }, [eveSystemId]);

  useEffect(() => {
    const close = () => setCtx(null);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, []);

  useEffect(() => {
    if (!activeMapId) return;

    const handlePaste = async (e: ClipboardEvent) => {
      const target = e.target as HTMLElement;
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable
      ) return;

      const text = e.clipboardData?.getData('text') ?? '';
      const parsed = parseStructureClipboard(text);
      if (parsed.length === 0) return;

      e.preventDefault();

      const existing = structuresRef.current;
      const toCreate = parsed.filter((p) => !existing.some((s) => s.eveId === p.eveId));
      // Parallel POSTs (n-up to ~dozens) instead of sequential await; the
      // gather-then-set pattern also avoids N intermediate renders.
      const created = (await Promise.all(
        toCreate.map((p) =>
          api<Structure>(
            `/api/maps/${activeMapId}/systems/${systemId}/structures`,
            { method: 'POST', body: JSON.stringify({ name: p.name, structureType: p.structureType, eveId: p.eveId }) },
          ).catch(() => null),
        ),
      )).filter((s): s is Structure => s !== null);
      if (created.length) setStructures((prev) => [...prev, ...created]);
    };

    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, [activeMapId, systemId]);

  const addStructure = async () => {
    if (!activeMapId) return;
    const s = await api<Structure>(
      `/api/maps/${activeMapId}/systems/${systemId}/structures`,
      { method: 'POST', body: JSON.stringify({}) },
    );
    setStructures((prev) => [...prev, s]);
  };

  const updateStructure = (id: string, updates: Partial<Structure>) => {
    setStructures((prev) => prev.map((s) => s.id === id ? { ...s, ...updates } : s));

    pendingUpdates.current.set(id, { ...(pendingUpdates.current.get(id) ?? {}), ...updates });
    clearTimeout(debounceTimers.current.get(id));
    debounceTimers.current.set(id, setTimeout(async () => {
      const payload = pendingUpdates.current.get(id);
      if (!payload || !activeMapId) return;
      pendingUpdates.current.delete(id);
      api(`/api/maps/${activeMapId}/systems/${systemId}/structures/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }).catch(() => toast.error('Failed to save structure'));
    }, 500));
  };

  const deleteStructure = (id: string) => {
    if (!activeMapId) return;
    setStructures((prev) => prev.filter((s) => s.id !== id));
    api(`/api/maps/${activeMapId}/systems/${systemId}/structures/${id}`, { method: 'DELETE' })
      .catch(() => toast.error('Failed to delete structure'));
  };

  const deleteAll = () => {
    const count = structuresRef.current.length;
    const action = () => { for (const s of structuresRef.current) deleteStructure(s.id); };
    if (shouldSkipConfirm()) { action(); return; }
    setPendingAction({ message: `Delete all ${count} structure${count !== 1 ? 's' : ''}?`, fn: action });
  };

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
        {canEdit && (
          <div className="sig-pane__toolbar">
            <button className="icon-btn" onClick={addStructure} title="Add structure">+</button>
            {structures.length > 0 && (
              <button className="sig-toolbar-btn sig-toolbar-btn--danger" onClick={deleteAll}>
                Delete all
              </button>
            )}
          </div>
        )}

        {structures.length === 0 ? (
          <div className="sig-pane__empty">No structures recorded</div>
        ) : (
          <table className="sig-table">
            <colgroup>
              <col style={{ width: '160px' }} />
              <col className="sig-col--type" />
              <col style={{ width: '130px' }} />
              <col style={{ width: '110px' }} />
              <col className="sig-col--notes" />
              <col className="sig-col--actions" />
            </colgroup>
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>Owner Corp</th>
                <th title="EVE structure ID for waypoint navigation">EVE ID</th>
                <th>Notes</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {structures.map((s) => {
                const ownerStanding = s.ownerCorpId && standings.loaded
                  ? standings.getStanding('corporation', s.ownerCorpId).effective
                  : 0;
                const tintClass =
                  ownerStanding <  -5 ? 'structure-row--hostile'  :
                  ownerStanding <   0 ? 'structure-row--bad'      :
                  ownerStanding >   5 ? 'structure-row--friendly' :
                  ownerStanding >   0 ? 'structure-row--good'     :
                                        '';
                return (
                <tr
                  key={s.id}
                  className={tintClass}
                  onContextMenu={(e) => {
                    if (!s.eveId) return;
                    e.preventDefault();
                    e.stopPropagation();
                    setCtx({ x: e.clientX, y: e.clientY, structure: s });
                  }}
                >
                  <td>
                    <input
                      className="sig-input"
                      value={s.name}
                      onChange={(e) => updateStructure(s.id, { name: e.target.value })}
                      placeholder="Structure name"
                    />
                  </td>
                  <td>
                    <select
                      className="sig-select"
                      value={s.structureType}
                      onChange={(e) => updateStructure(s.id, { structureType: e.target.value as StructureType })}
                    >
                      {(Object.keys(STRUCTURE_TYPE_LABELS) as StructureType[]).map((t) => (
                        <option key={t} value={t}>{STRUCTURE_TYPE_LABELS[t]}</option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <input
                      className="sig-input"
                      value={s.ownerCorp}
                      onChange={(e) => updateStructure(s.id, { ownerCorp: e.target.value })}
                      placeholder="Corp name"
                    />
                  </td>
                  <td>
                    <input
                      className="sig-input sig-input--id"
                      value={s.eveId ?? ''}
                      onChange={(e) => {
                        const v = e.target.value.replace(/\D/g, '');
                        updateStructure(s.id, { eveId: v ? Number(v) : null });
                      }}
                      placeholder="Optional"
                    />
                  </td>
                  <td className="sig-notes-cell">
                    <NotesEditor
                      value={s.notes}
                      onChange={(v) => updateStructure(s.id, { notes: v })}
                      compact
                    />
                  </td>
                  <td>
                    {canEdit && (
                      <button
                        className="icon-btn icon-btn--danger"
                        onClick={() => deleteStructure(s.id)}
                        title="Delete"
                      >✕</button>
                    )}
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <KnownStructuresList
          known={knownStructures}
          manual={structures}
          standings={standings}
        />
      </div>

      {ctx && createPortal(
        <ContextMenu
          x={ctx.x}
          y={ctx.y}
          onClose={() => setCtx(null)}
          items={[
            {
              label: 'Set Destination',
              icon: '🎯',
              action: () => setDestination(ctx.structure.eveId!).catch(console.error),
            },
            {
              label: 'Add Waypoint',
              icon: '📍',
              action: () => addWaypoint(ctx.structure.eveId!).catch(console.error),
            },
          ]}
        />,
        document.body,
      )}
    </>
  );
}

// Read-only list of auto-discovered structures (corp ESI + public dataset).
// Deduped against the user's manual entries by eve_id so the same citadel
// doesn't appear twice. Owner-corp standing drives the row tint, same as
// the manual table.
function KnownStructuresList({
  known,
  manual,
  standings,
}: {
  known:    KnownStructure[];
  manual:   Structure[];
  standings: ReturnType<typeof useStandings>;
}) {
  const manualEveIds = new Set(manual.map((s) => s.eveId).filter((id): id is number => id !== null));
  const rows = known.filter((k) => !manualEveIds.has(Number(k.structureId)));
  if (rows.length === 0) return null;

  return (
    <div className="known-structures">
      <div className="known-structures__heading">
        Auto-discovered ({rows.length})
        <span className="known-structures__hint">read-only · paste an in-game structure list to import as your own</span>
      </div>
      <table className="sig-table known-structures__table">
        <thead>
          <tr>
            <th>Source</th>
            <th>Name</th>
            <th>Owner</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((k) => {
            const ownerStanding = k.ownerCorpId && standings.loaded
              ? standings.getStanding('corporation', k.ownerCorpId).effective
              : 0;
            const tintClass =
              ownerStanding <  -5 ? 'structure-row--hostile'  :
              ownerStanding <   0 ? 'structure-row--bad'      :
              ownerStanding >   5 ? 'structure-row--friendly' :
              ownerStanding >   0 ? 'structure-row--good'     :
                                    '';
            return (
              <tr key={k.structureId} className={tintClass}>
                <td className="known-structures__source">
                  <span className={`known-structures__badge known-structures__badge--${k.source}`}>
                    {k.source === 'corp-esi' ? 'Corp' : 'Public'}
                  </span>
                </td>
                <td>{k.name || `#${k.structureId}`}</td>
                <td>{k.ownerCorpId ? `Corp #${k.ownerCorpId}` : '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
