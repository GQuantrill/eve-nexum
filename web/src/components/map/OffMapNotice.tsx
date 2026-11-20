import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useOffMapReason } from '../../hooks/useOffMapReason';
import { applyJump } from '../../hooks/useLocationTracking';
import { useMapStore } from '../../store/mapStore';
import { MapPinIcon, XIcon } from '../../icons';

// Shown on the map when the system you're in isn't on it: says why (the map
// skips K-space, tracking is off, read-only, locked) and, where you may, adds
// it. Without this the "you are here" box and the signature panel just
// vanished and nexum looked broken.
export function OffMapNotice() {
  const { t } = useTranslation();
  const off = useOffMapReason();
  const mapId = useMapStore((s) => s.map.id);
  // Closed stays closed on this map for this reason (until reload), so a pilot
  // flying twenty gates of nullsec isn't asked again at every one. Another map,
  // or a different reason, shows it again.
  const [closed, setClosed] = useState<string[]>([]);
  const key = off ? `${mapId}:${off.reason}` : '';
  if (!off || closed.includes(key)) return null;

  const add = () => {
    const s = off.system;
    const id = applyJump({
      eveSystemId: s.eveSystemId, name: s.name, systemClass: s.systemClass, effect: s.effect,
      statics: s.statics, regionName: s.regionName ?? null, npcType: s.npcType ?? null,
    }, null, true);
    if (!id) return;
    const { setCurrentSystem, selectSystem } = useMapStore.getState();
    setCurrentSystem(id);
    selectSystem(id, { fromJump: true });
  };

  return (
    <div className="off-map" role="status">
      <MapPinIcon size={13} weight="fill" className="off-map__icon" />
      <div className="off-map__text">
        <strong>{t('offMap.title', { system: off.system.name })}</strong>
        <span>{t(`offMap.${off.reason}`)}</span>
      </div>
      {off.canAdd && (
        <button type="button" className="off-map__add" onClick={add}>{t('offMap.add')}</button>
      )}
      <button
        type="button"
        className="off-map__close"
        aria-label={t('offMap.hide')}
        data-tooltip={t('offMap.hide')}
        onClick={() => setClosed((c) => [...c, key])}
      >
        <XIcon size={12} />
      </button>
    </div>
  );
}
