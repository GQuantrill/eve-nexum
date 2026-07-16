import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { XIcon } from '@phosphor-icons/react';
import { api } from '../../api/client';
import { useMapStore } from '../../store/mapStore';
import { useAuth, isAdminRole, isAllianceAdminRole } from '../../context/AuthContext';
import { toast } from './Toaster';

type MapType = 'personal' | 'corp' | 'alliance';
const TYPE_LABEL = { personal: 'copyMap.typePersonal', corp: 'copyMap.typeCorp', alliance: 'copyMap.typeAlliance' } as const;

// Duplicate the active map. Source is fixed (the active map, shown read-only); the
// four toggles gate system notes / signatures / structures / anomalies — topology
// + intel/labels always copy. The copy's scope can be chosen (Personal / Corp /
// Alliance) — e.g. turn a personal map into a corp map, or an alliance map into a
// corp one — limited to the scopes the caller may create; the server re-checks
// role/affiliation/quota. (Maps merely shared with the caller can't be copied at
// all — the Copy action is hidden for them and the server 403s.)
export function CopyMapModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const activeMapId    = useMapStore((s) => s.activeMapId);
  const sourceName     = useMapStore((s) => s.map.name);
  const maps           = useMapStore((s) => s.maps);
  const switchMap      = useMapStore((s) => s.switchMap);
  const loadMaps       = useMapStore((s) => s.loadMaps);
  const requestFitView = useMapStore((s) => s.requestFitView);

  const source        = maps.find((m) => m.id === activeMapId);
  const role          = user?.role ?? 'readonly';
  const canCorp       = (!!user?.corpMode || !!user?.allianceMode) && (role === 'full' || isAdminRole(role));
  const canAlliance   = !!user?.allianceMode && isAllianceAdminRole(role);
  const typeOptions: MapType[] = ['personal', ...(canCorp ? ['corp' as const] : []), ...(canAlliance ? ['alliance' as const] : [])];
  // Default to the source's own scope when the caller may create it, else personal.
  const defaultType: MapType = source?.isAllianceMap && canAlliance ? 'alliance'
    : source?.isCorpMap && canCorp ? 'corp' : 'personal';

  const [name, setName]             = useState(`${sourceName} Copy`);
  const [mapType, setMapType]       = useState<MapType>(defaultType);
  const [notes, setNotes]           = useState(true);
  const [signatures, setSignatures] = useState(true);
  const [structures, setStructures] = useState(true);
  const [anomalies, setAnomalies]   = useState(true);
  const [busy, setBusy]   = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = name.trim();
  const canCopy = !!activeMapId && !!trimmed && !busy;
  // Offer the scope picker whenever there's more than one scope the caller may
  // create — so a personal ("solo") map can be copied into a corp/alliance map too.
  const showTypePicker = typeOptions.length > 1;

  async function doCopy() {
    if (!canCopy || !activeMapId) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ id: string }>(`/api/maps/${activeMapId}/copy`, {
        method: 'POST',
        body: JSON.stringify({
          name: trimmed,
          isCorpMap:     showTypePicker && mapType === 'corp',
          isAllianceMap: showTypePicker && mapType === 'alliance',
          include: { notes, signatures, structures, anomalies },
        }),
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

          {showTypePicker && (
            <div className="field">
              <span>{t('copyMap.typeLabel')}</span>
              <div className="copymap__type-group">
                {typeOptions.map((o) => (
                  <button
                    key={o}
                    type="button"
                    className={`copymap__type-btn${mapType === o ? ' copymap__type-btn--active' : ''}`}
                    onClick={() => setMapType(o)}
                  >
                    {t(TYPE_LABEL[o])}
                  </button>
                ))}
              </div>
            </div>
          )}

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
