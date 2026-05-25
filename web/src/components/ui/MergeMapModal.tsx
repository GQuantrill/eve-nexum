import { useState } from 'react';
import { createPortal } from 'react-dom';
import { XIcon } from '@phosphor-icons/react';
import { api } from '../../api/client';
import { useMapStore, type MapListItem } from '../../store/mapStore';
import { useAuth } from '../../context/AuthContext';
import { toast } from './Toaster';

interface MergeResult {
  added:   { systems: number; connections: number; signatures: number; structures: number };
  updated: { signatures: number; structures: number; systemNotes: number };
}

// Roles that can write to a corp map (and therefore use one as a destination).
const CORP_WRITE_ROLES = new Set(['edit', 'full', 'admin']);

function mapLabel(m: MapListItem): string {
  const kind = m.isCorpMap ? 'Corp' : 'Solo';
  return m.ownerName ? `${m.name} — ${kind} · ${m.ownerName}` : `${m.name} — ${kind}`;
}

export function MergeMapModal({ onClose }: { onClose: () => void }) {
  const maps        = useMapStore((s) => s.maps);
  const activeMapId = useMapStore((s) => s.activeMapId);
  const switchMap   = useMapStore((s) => s.switchMap);
  const loadMaps    = useMapStore((s) => s.loadMaps);
  const { user }    = useAuth();
  const role    = user?.role ?? 'readonly';
  const isAdmin = role === 'admin';

  // Source: any solo map the user can see (owned or shared), or a corp map
  // explicitly flagged as a merge source. Destination: maps the user can write
  // to — solo always, corp only with an editor role. Locked maps are excluded
  // as destinations unless we're admin. The server re-checks all of this.
  const sourceOptions = maps.filter((m) => (m.isCorpMap ? m.allowAsMergeSource === true : true));
  const destOptions   = maps.filter((m) => {
    if (m.locked && !isAdmin) return false;
    return m.isCorpMap ? CORP_WRITE_ROLES.has(role) : true;
  });

  const [sourceId, setSourceId] = useState('');
  const [destId, setDestId] = useState(
    activeMapId && destOptions.some((m) => m.id === activeMapId) ? activeMapId : '',
  );
  const [includeSignatures, setIncludeSignatures] = useState(true);
  const [includeStructures, setIncludeStructures] = useState(true);
  const [includeNotes, setIncludeNotes] = useState(true);
  const [busy, setBusy]   = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sameMap  = !!sourceId && sourceId === destId;
  const canMerge = !!sourceId && !!destId && !sameMap && !busy;

  async function doMerge() {
    if (!canMerge) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<MergeResult>(`/api/maps/${destId}/merge`, {
        method: 'POST',
        body: JSON.stringify({
          sourceId,
          include: {
            signatures: includeSignatures,
            structures: includeStructures,
            notes: includeNotes,
          },
        }),
      });
      const a = r.added;
      toast.success(
        `Merged: +${a.systems} systems, +${a.connections} links, +${a.signatures} sigs, +${a.structures} structures`,
      );
      await loadMaps();
      await switchMap(destId);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Merge failed');
    } finally {
      setBusy(false);
    }
  }

  return createPortal(
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true">
        <div className="modal__header">
          <h2 className="modal__title">Merge Maps</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <XIcon size={16} weight="bold" />
          </button>
        </div>

        <div className="modal__body">
          <label className="field">
            <span>Source map (merge from)</span>
            <select value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
              <option value="">Select a source…</option>
              {sourceOptions.map((m) => (
                <option key={m.id} value={m.id}>{mapLabel(m)}</option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>Destination map (merge into)</span>
            <select value={destId} onChange={(e) => setDestId(e.target.value)}>
              <option value="">Select a destination…</option>
              {destOptions.map((m) => (
                <option key={m.id} value={m.id}>{mapLabel(m)}</option>
              ))}
            </select>
          </label>

          {sameMap && (
            <div className="map-sidebar__hint map-sidebar__hint--error">
              Source and destination must be different maps.
            </div>
          )}

          <div className="field">
            <span>Include</span>
            <label className="map-sidebar__row map-sidebar__toggle-row">
              <span className="map-sidebar__label">Signatures</span>
              <input
                type="checkbox"
                className="map-sidebar__toggle-input"
                checked={includeSignatures}
                onChange={(e) => setIncludeSignatures(e.target.checked)}
              />
            </label>
            <label className="map-sidebar__row map-sidebar__toggle-row">
              <span className="map-sidebar__label">Structures</span>
              <input
                type="checkbox"
                className="map-sidebar__toggle-input"
                checked={includeStructures}
                onChange={(e) => setIncludeStructures(e.target.checked)}
              />
            </label>
            <label className="map-sidebar__row map-sidebar__toggle-row">
              <span className="map-sidebar__label">Notes</span>
              <input
                type="checkbox"
                className="map-sidebar__toggle-input"
                checked={includeNotes}
                onChange={(e) => setIncludeNotes(e.target.checked)}
              />
            </label>
          </div>

          <div className="map-sidebar__hint">
            Systems already on the destination are kept as the source of truth —
            only missing systems, links, and the selected data are added or
            updated. <strong>This action cannot be undone.</strong>
          </div>

          {error && <div className="map-sidebar__hint map-sidebar__hint--error">{error}</div>}

          <div className="modal__actions">
            <button type="button" className="btn btn--ghost" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button type="button" className="btn btn--primary" onClick={doMerge} disabled={!canMerge}>
              {busy ? 'Merging…' : 'Merge'}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
