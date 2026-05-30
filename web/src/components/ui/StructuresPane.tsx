import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
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
  const { t } = useTranslation();
  const typeLabel = (type: StructureType) =>
    type === 'unknown' ? t('structures.unknown') : STRUCTURE_TYPE_LABELS[type];
  const activeMapId = useMapStore((s) => s.activeMapId);
  const canEdit     = useCanEditContent();
  const standings   = useStandings();
  const [structures, setStructures] = useState<Structure[]>([]);
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
      .catch(() => toast.error(t('structures.loadFailed')));
  }, [activeMapId, systemId, isShareMode]);

  // Live sync: re-fetch in place when a remote client changes this system's
  // structures. Guarded so it doesn't fire on the initial mount (rev 0).
  useEffect(() => {
    if (!activeMapId || isShareMode || structRev === 0) return;
    api<Structure[]>(`/api/maps/${activeMapId}/systems/${systemId}/structures`)
      .then(setStructures)
      .catch(() => {});
  }, [structRev, activeMapId, systemId, isShareMode]);

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
      }).catch(() => toast.error(t('structures.saveFailed')));
    }, 500));
  };

  const deleteStructure = (id: string) => {
    if (!activeMapId) return;
    setStructures((prev) => prev.filter((s) => s.id !== id));
    api(`/api/maps/${activeMapId}/systems/${systemId}/structures/${id}`, { method: 'DELETE' })
      .catch(() => toast.error(t('structures.deleteFailed')));
  };

  const deleteAll = () => {
    const count = structuresRef.current.length;
    const action = () => { for (const s of structuresRef.current) deleteStructure(s.id); };
    if (shouldSkipConfirm()) { action(); return; }
    setPendingAction({ message: t('structures.deleteAllConfirm', { count }), fn: action });
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
        {!isShareMode && structures.length === 0 && (
          <p className="sig-pane__hint">{t('structures.pasteHint')}</p>
        )}
        {canEdit && !isShareMode && (
          <div className="sig-pane__toolbar">
            <button className="icon-btn" onClick={addStructure} title={t('structures.addStructure')}>+</button>
            {structures.length > 0 && (
              <button className="sig-toolbar-btn sig-toolbar-btn--danger" onClick={deleteAll}>
                {t('structures.deleteAll')}
              </button>
            )}
          </div>
        )}

        {structures.length === 0 ? (
          <div className="sig-pane__empty">{t('structures.none')}</div>
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
                <th>{t('structures.name')}</th>
                <th>{t('structures.type')}</th>
                <th>{t('structures.ownerCorp')}</th>
                <th title={t('structures.eveIdTooltip')}>{t('structures.eveId')}</th>
                <th>{t('structures.notes')}</th>
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
                        placeholder={t('structures.namePlaceholder')}
                      />
                    )}
                  </td>
                  <td>
                    {isShareMode ? (
                      <span className="sig-text">{typeLabel(s.structureType)}</span>
                    ) : (
                      <select
                        className="sig-select"
                        value={s.structureType}
                        onChange={(e) => updateStructure(s.id, { structureType: e.target.value as StructureType })}
                      >
                        {(Object.keys(STRUCTURE_TYPE_LABELS) as StructureType[]).map((st) => (
                          <option key={st} value={st}>{typeLabel(st)}</option>
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
                        placeholder={t('structures.corpPlaceholder')}
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
                        placeholder={t('structures.optionalPlaceholder')}
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
                          title={t('actions.delete')}
                        ><XIcon size={12} weight="bold" /></button>
                      )}
                    </td>
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
              label: t('waypoint.setDestination'),
              icon: <MapPinSimpleIcon size={16} weight="regular" color="#3ddc84" />,
              action: () => setDestination(ctx.structure.eveId!).catch(console.error),
            },
            {
              label: t('waypoint.addWaypoint'),
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
