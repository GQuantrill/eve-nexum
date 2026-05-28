import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../../api/client';
import { useMapStore } from '../../store/mapStore';
import { useShareMode } from '../../context/ShareModeContext';
import type { Structure, StructureType } from '../../types';
import { NotesEditor } from './NotesEditor';
import { ConfirmModal, shouldSkipConfirm } from './ConfirmModal';
import { ContextMenu } from './ContextMenu';
import { XIcon, PathIcon, MapPinSimpleIcon } from '@phosphor-icons/react';
import { setDestination, addWaypoint } from '../../api/waypoint';
import { toast } from './Toaster';
import { useCanEditContent } from '../../hooks/useCanEditContent';
import { useStandings } from '../../hooks/useStandings';
import { useAuth } from '../../context/AuthContext';

interface ESICorpStructure {
  structure_id: number;
  corporation_id: number;
  system_id: number;
  type_id: number;
  name: string;
  state: string;
  fuel_expires: string | null;
  services: { name: string; state: string }[];
  reinforce_hour: number | null;
  state_timer_start: string | null;
  state_timer_end: string | null;
  unanchors_at: string | null;
  last_polled: string;
  type_name: string | null;
}

function fuelStatus(fuelExpires: string | null): { label: string; className: string } | null {
  if (!fuelExpires) return null;
  const hoursLeft = (new Date(fuelExpires).getTime() - Date.now()) / (1000 * 60 * 60);
  if (hoursLeft <= 0) return { label: 'EMPTY', className: 'fuel--empty' };
  if (hoursLeft < 24) return { label: `${Math.round(hoursLeft)}h`, className: 'fuel--critical' };
  if (hoursLeft < 72) {
    const d = Math.floor(hoursLeft / 24);
    const h = Math.round(hoursLeft % 24);
    return { label: `${d}d ${h}h`, className: 'fuel--warning' };
  }
  if (hoursLeft < 168) return { label: `${Math.round(hoursLeft / 24)}d`, className: 'fuel--caution' };
  return { label: `${Math.round(hoursLeft / 24)}d`, className: 'fuel--ok' };
}

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

export function StructuresPane({ systemId }: { systemId: string }) {
  const activeMapId = useMapStore((s) => s.activeMapId);
  const canEdit     = useCanEditContent();
  const standings   = useStandings();
  const { user }    = useAuth();
  const [structures, setStructures] = useState<Structure[]>([]);
  const [esiStructures, setEsiStructures] = useState<ESICorpStructure[]>([]);
  const [pendingAction, setPendingAction] = useState<{ message: string; fn: () => void } | null>(null);
  const [ctx, setCtx] = useState<{ x: number; y: number; structure: Structure } | null>(null);

  const pendingUpdates = useRef<Map<string, Partial<Structure>>>(new Map());
  const debounceTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const structuresRef = useRef<Structure[]>([]);
  structuresRef.current = structures;

  const { isShareMode } = useShareMode();
  // Bumped when another client changes this system's structures (live sync).
  const structRev = useMapStore((s) => s.structRev[systemId] ?? 0);

  useEffect(() => {
    if (!activeMapId) return;
    setStructures([]);

    // Share viewers have structures embedded per-system in the share
    // payload. The /api/maps route would 22P02 on the 'shared' mapId,
    // so read from the store instead.
    if (isShareMode) {
      const sys = useMapStore.getState().map.systems.find((s) => s.id === systemId);
      const embedded = (sys as { structures?: Structure[] } | undefined)?.structures ?? [];
      setStructures(embedded);
      return;
    }

    api<Structure[]>(`/api/maps/${activeMapId}/systems/${systemId}/structures`)
      .then(setStructures)
      .catch(() => toast.error('Failed to load structures'));
  }, [activeMapId, systemId, isShareMode]);

  // Live sync: re-fetch in place when a remote client changes this system's
  // structures. Guarded so it doesn't fire on the initial mount (rev 0).
  useEffect(() => {
    if (!activeMapId || isShareMode || structRev === 0) return;
    api<Structure[]>(`/api/maps/${activeMapId}/systems/${systemId}/structures`)
      .then(setStructures)
      .catch(() => {});
  }, [structRev, activeMapId, systemId, isShareMode]);

  const eveSystemId = useMapStore((s) => {
    const sys = s.map.systems.find((sys) => sys.id === systemId);
    return sys?.eveSystemId ?? null;
  });

  useEffect(() => {
    if (!eveSystemId || isShareMode || !user?.corpMode) return;
    api<ESICorpStructure[]>(`/api/corp-structures/by-system/${eveSystemId}`)
      .then(setEsiStructures)
      .catch(() => setEsiStructures([]));
  }, [eveSystemId, isShareMode, user?.corpMode]);

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
        {user?.corpMode && user.hasStationManager && !user.hasStructuresScope && (
          <div className="structures-pane__grant-banner">
            <span>Enable structure tracking for your corp</span>
            <a href="/auth/grant-structures" className="structures-pane__grant-link">
              Authorize with EVE Online
            </a>
          </div>
        )}
        {!isShareMode && structures.length === 0 && esiStructures.length === 0 && (
          <p className="sig-pane__hint">You can copy and paste structures directly from your Overview in EVE. In space, right-click anywhere in your Overview window and choose "Copy Selected Rows" (or select the lines and Ctrl+C). Paste here with Ctrl+V — the structure ID, name, and type are imported automatically.</p>
        )}
        {canEdit && !isShareMode && (
          <div className="sig-pane__toolbar">
            <button className="icon-btn" onClick={addStructure} title="Add structure">+</button>
            {structures.length > 0 && (
              <button className="sig-toolbar-btn sig-toolbar-btn--danger" onClick={deleteAll}>
                Delete all
              </button>
            )}
          </div>
        )}

        {structures.length === 0 && esiStructures.length === 0 ? (
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
                {!isShareMode && <th />}
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
                    {isShareMode ? (
                      <span className="sig-text">{s.name}</span>
                    ) : (
                      <input
                        className="sig-input"
                        value={s.name}
                        onChange={(e) => updateStructure(s.id, { name: e.target.value })}
                        placeholder="Structure name"
                      />
                    )}
                  </td>
                  <td>
                    {isShareMode ? (
                      <span className="sig-text">{STRUCTURE_TYPE_LABELS[s.structureType]}</span>
                    ) : (
                      <select
                        className="sig-select"
                        value={s.structureType}
                        onChange={(e) => updateStructure(s.id, { structureType: e.target.value as StructureType })}
                      >
                        {(Object.keys(STRUCTURE_TYPE_LABELS) as StructureType[]).map((t) => (
                          <option key={t} value={t}>{STRUCTURE_TYPE_LABELS[t]}</option>
                        ))}
                      </select>
                    )}
                  </td>
                  <td>
                    {isShareMode ? (
                      <span className="sig-text">{s.ownerCorp}</span>
                    ) : (
                      <input
                        className="sig-input"
                        value={s.ownerCorp}
                        onChange={(e) => updateStructure(s.id, { ownerCorp: e.target.value })}
                        placeholder="Corp name"
                      />
                    )}
                  </td>
                  <td>
                    {isShareMode ? (
                      <span className="sig-text sig-text--id">{s.eveId ?? ''}</span>
                    ) : (
                      <input
                        className="sig-input sig-input--id"
                        value={s.eveId ?? ''}
                        onChange={(e) => {
                          const v = e.target.value.replace(/\D/g, '');
                          updateStructure(s.id, { eveId: v ? Number(v) : null });
                        }}
                        placeholder="Optional"
                      />
                    )}
                  </td>
                  <td className="sig-notes-cell">
                    <NotesEditor
                      value={s.notes}
                      onChange={(v) => updateStructure(s.id, { notes: v })}
                      compact
                      readOnly={!canEdit || isShareMode}
                    />
                  </td>
                  {!isShareMode && (
                    <td>
                      {canEdit && (
                        <button
                          className="icon-btn icon-btn--danger"
                          onClick={() => deleteStructure(s.id)}
                          title="Delete"
                        ><XIcon size={12} weight="bold" /></button>
                      )}
                    </td>
                  )}
                </tr>
                );
              })}
              {esiStructures
                .filter((esi) => !structures.some((s) => s.eveId === esi.structure_id))
                .map((esi) => {
                  const fuel = fuelStatus(esi.fuel_expires);
                  return (
                    <tr key={`esi-${esi.structure_id}`} className="structures-pane__row--esi">
                      <td>{esi.name}</td>
                      <td>{esi.type_name ?? `Type ${esi.type_id}`}</td>
                      <td>
                        <span className={`structures-pane__state structures-pane__state--${esi.state}`}>
                          {esi.state.replace(/_/g, ' ')}
                        </span>
                      </td>
                      <td>
                        {fuel && <span className={`structures-pane__fuel ${fuel.className}`}>{fuel.label}</span>}
                      </td>
                      <td>
                        {(esi.services ?? []).map((svc) => (
                          <span key={svc.name} className={`structures-pane__service structures-pane__service--${svc.state}`}>
                            {svc.name}
                          </span>
                        ))}
                      </td>
                      {!isShareMode && (
                        <td><span className="structures-pane__esi-tag">ESI</span></td>
                      )}
                    </tr>
                  );
                })}
            </tbody>
          </table>
        )}
      </div>

      {ctx && createPortal(
        <ContextMenu
          x={ctx.x}
          y={ctx.y}
          onClose={() => setCtx(null)}
          items={[
            {
              label: 'Set Destination',
              icon: <MapPinSimpleIcon size={16} weight="regular" color="#3ddc84" />,
              action: () => setDestination(ctx.structure.eveId!).catch(console.error),
            },
            {
              label: 'Add Waypoint',
              icon: <PathIcon size={16} weight="regular" color="#5a9af8" />,
              action: () => addWaypoint(ctx.structure.eveId!).catch(console.error),
            },
          ]}
        />,
        document.body,
      )}
    </>
  );
}
