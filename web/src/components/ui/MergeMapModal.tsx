import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Trans, useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
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

function mapLabel(t: TFunction, m: MapListItem): string {
  const kind = m.isCorpMap ? t('merge.corp') : t('merge.solo');
  return m.ownerName ? `${m.name} — ${kind} · ${m.ownerName}` : `${m.name} — ${kind}`;
}

export function MergeMapModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const maps        = useMapStore((s) => s.maps);
  const activeMapId = useMapStore((s) => s.activeMapId);
  const switchMap   = useMapStore((s) => s.switchMap);
  const loadMaps    = useMapStore((s) => s.loadMaps);
  const requestFitView = useMapStore((s) => s.requestFitView);
  const { user }    = useAuth();
  const role    = user?.role ?? 'readonly';
  const isAdmin = role === 'admin';

  // Source: any solo map the user can see (owned or shared), or a corp map
  // explicitly flagged as a merge source. Destination: maps the user can write
  // to — solo always, corp only with an editor role AND flagged as a merge
  // destination. Locked maps are excluded as destinations unless we're admin.
  // The server re-checks all of this.
  const sourceOptions = maps.filter((m) => (m.isCorpMap ? m.allowAsMergeSource === true : true));
  const destOptions   = maps.filter((m) => {
    if (m.locked && !isAdmin) return false;
    return m.isCorpMap ? (CORP_WRITE_ROLES.has(role) && m.allowAsMergeDestination === true) : true;
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
        t('merge.merged', { systems: a.systems, connections: a.connections, signatures: a.signatures, structures: a.structures }),
      );
      await loadMaps();
      await switchMap(destId);
      requestFitView();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('merge.mergeFailed'));
    } finally {
      setBusy(false);
    }
  }

  return createPortal(
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true">
        <div className="modal__header">
          <h2 className="modal__title">{t('merge.title')}</h2>
          <button className="icon-btn" onClick={onClose} aria-label={t('actions.close')}>
            <XIcon size={16} weight="bold" />
          </button>
        </div>

        <div className="modal__body">
          <label className="field">
            <span>{t('merge.sourceMap')}</span>
            <select value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
              <option value="">{t('merge.selectSource')}</option>
              {sourceOptions.map((m) => (
                <option key={m.id} value={m.id}>{mapLabel(t, m)}</option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>{t('merge.destMap')}</span>
            <select value={destId} onChange={(e) => setDestId(e.target.value)}>
              <option value="">{t('merge.selectDest')}</option>
              {destOptions.map((m) => (
                <option key={m.id} value={m.id}>{mapLabel(t, m)}</option>
              ))}
            </select>
          </label>

          {sameMap && (
            <div className="map-sidebar__hint map-sidebar__hint--error">
              {t('merge.differentMaps')}
            </div>
          )}

          <div className="field">
            <span>{t('merge.include')}</span>
            <label className="map-sidebar__row map-sidebar__toggle-row">
              <span className="map-sidebar__label">{t('merge.signatures')}</span>
              <input
                type="checkbox"
                className="map-sidebar__toggle-input"
                checked={includeSignatures}
                onChange={(e) => setIncludeSignatures(e.target.checked)}
              />
            </label>
            <label className="map-sidebar__row map-sidebar__toggle-row">
              <span className="map-sidebar__label">{t('merge.structures')}</span>
              <input
                type="checkbox"
                className="map-sidebar__toggle-input"
                checked={includeStructures}
                onChange={(e) => setIncludeStructures(e.target.checked)}
              />
            </label>
            <label className="map-sidebar__row map-sidebar__toggle-row">
              <span className="map-sidebar__label">{t('merge.notes')}</span>
              <input
                type="checkbox"
                className="map-sidebar__toggle-input"
                checked={includeNotes}
                onChange={(e) => setIncludeNotes(e.target.checked)}
              />
            </label>
          </div>

          <div className="map-sidebar__hint">
            <Trans i18nKey="merge.hint" />
          </div>

          {error && <div className="map-sidebar__hint map-sidebar__hint--error">{error}</div>}

          <div className="modal__actions">
            <button type="button" className="btn btn--ghost" onClick={onClose} disabled={busy}>
              {t('actions.cancel')}
            </button>
            <button type="button" className="btn btn--primary" onClick={doMerge} disabled={!canMerge}>
              {busy ? t('merge.merging') : t('merge.merge')}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
