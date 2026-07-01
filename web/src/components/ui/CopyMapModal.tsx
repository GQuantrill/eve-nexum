import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { XIcon } from '@phosphor-icons/react';
import { api } from '../../api/client';
import { useMapStore } from '../../store/mapStore';
import { toast } from './Toaster';

// Duplicate the active map into a new personal map. Source is fixed (the active
// map, shown read-only); the four toggles gate system notes / signatures /
// structures / anomalies — topology + intel/labels always copy.
export function CopyMapModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const activeMapId    = useMapStore((s) => s.activeMapId);
  const sourceName     = useMapStore((s) => s.map.name);
  const switchMap      = useMapStore((s) => s.switchMap);
  const loadMaps       = useMapStore((s) => s.loadMaps);
  const requestFitView = useMapStore((s) => s.requestFitView);

  const [name, setName]             = useState(`${sourceName} Copy`);
  const [notes, setNotes]           = useState(true);
  const [signatures, setSignatures] = useState(true);
  const [structures, setStructures] = useState(true);
  const [anomalies, setAnomalies]   = useState(true);
  const [busy, setBusy]   = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = name.trim();
  const canCopy = !!activeMapId && !!trimmed && !busy;

  async function doCopy() {
    if (!canCopy || !activeMapId) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ id: string }>(`/api/maps/${activeMapId}/copy`, {
        method: 'POST',
        body: JSON.stringify({ name: trimmed, include: { notes, signatures, structures, anomalies } }),
      });
      toast.success(t('copyMap.success', { name: trimmed }));
      await loadMaps();
      await switchMap(r.id);
      requestFitView();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('copyMap.failed'));
    } finally {
      setBusy(false);
    }
  }

  return createPortal(
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true">
        <div className="modal__header">
          <h2 className="modal__title">{t('copyMap.title')}</h2>
          <button className="icon-btn" onClick={onClose} aria-label={t('actions.close')}>
            <XIcon size={16} weight="bold" />
          </button>
        </div>

        <div className="modal__body">
          <label className="field">
            <span>{t('copyMap.sourceLabel')}</span>
            <input type="text" value={sourceName} readOnly />
          </label>

          <label className="field">
            <span>{t('copyMap.nameLabel')}</span>
            <input
              type="text"
              value={name}
              maxLength={200}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('copyMap.namePlaceholder')}
              autoFocus
            />
          </label>

          <div className="field">
            <span>{t('copyMap.include')}</span>
            <label className="map-sidebar__row map-sidebar__toggle-row">
              <span className="map-sidebar__label">{t('copyMap.copyNotes')}</span>
              <input type="checkbox" className="map-sidebar__toggle-input"
                checked={notes} onChange={(e) => setNotes(e.target.checked)} />
            </label>
            <label className="map-sidebar__row map-sidebar__toggle-row">
              <span className="map-sidebar__label">{t('copyMap.copySignatures')}</span>
              <input type="checkbox" className="map-sidebar__toggle-input"
                checked={signatures} onChange={(e) => setSignatures(e.target.checked)} />
            </label>
            <label className="map-sidebar__row map-sidebar__toggle-row">
              <span className="map-sidebar__label">{t('copyMap.copyStructures')}</span>
              <input type="checkbox" className="map-sidebar__toggle-input"
                checked={structures} onChange={(e) => setStructures(e.target.checked)} />
            </label>
            <label className="map-sidebar__row map-sidebar__toggle-row">
              <span className="map-sidebar__label">{t('copyMap.copyAnomalies')}</span>
              <input type="checkbox" className="map-sidebar__toggle-input"
                checked={anomalies} onChange={(e) => setAnomalies(e.target.checked)} />
            </label>
          </div>

          {error && <div className="map-sidebar__hint map-sidebar__hint--error">{error}</div>}

          <div className="modal__actions">
            <button type="button" className="btn btn--ghost" onClick={onClose} disabled={busy}>
              {t('actions.cancel')}
            </button>
            <button type="button" className="btn btn--primary" onClick={doCopy} disabled={!canCopy}>
              {busy ? t('copyMap.copying') : t('copyMap.submit')}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
