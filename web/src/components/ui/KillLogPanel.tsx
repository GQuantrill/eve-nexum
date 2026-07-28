import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { XIcon, SkullIcon, ArrowSquareOutIcon } from '@phosphor-icons/react';
import { api } from '../../api/client';
import { useMapStore } from '../../store/mapStore';
import { useKillStore, useKillLog, type KillRow } from '../../store/killStore';
import { useNow30s } from '../../hooks/useNow30s';
import { charPortrait, corpLogo, typeRender } from '../../utils/eveImages';
import { iskCompact } from '../../utils/isk';

interface Props { onClose: () => void; }

// zKillboard permalink for a killmail.
const zkbLink = (killmailId: number) => `https://zkillboard.com/kill/${killmailId}/`;

// Compact age token ("3m" / "2h" / "1d"), or null for < 1 minute (rendered as
// the localised "now"). Kept unit-only so one translatable "{{d}} ago" wrapper
// works across locales.
function durToken(atMs: number, now: number): string | null {
  const s = Math.max(0, Math.floor((now - atMs) / 1000));
  if (s < 60) return null;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function KillRowItem({ k, now, onShow }: { k: KillRow; now: number; onShow: (eveSystemId: number) => void }) {
  const { t } = useTranslation();
  const portrait = k.victimCharacterId
    ? charPortrait(k.victimCharacterId, 64)
    : k.victimCorporationId ? corpLogo(k.victimCorporationId, 64) : null;
  const d = durToken(k.atMs, now);
  const ago = d ? t('killLog.ago', { d }) : t('time.now');
  return (
    // The row centres the map on the kill's system (and closes the panel); the
    // zKillboard permalink is a separate trailing icon so it doesn't hijack the
    // primary click.
    <div
      className="killlog__row"
      role="button"
      tabIndex={0}
      title={t('killLog.showOnMap')}
      onClick={() => onShow(k.eveSystemId)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onShow(k.eveSystemId); } }}
    >
      <div className="killlog__thumbs">
        {portrait && <img className="killlog__portrait" src={portrait} alt="" loading="lazy" />}
        <img className="killlog__ship" src={typeRender(k.shipTypeId, 64)} alt="" loading="lazy" />
      </div>
      <div className="killlog__who">
        <span className="killlog__victim">{k.victimName ?? t('killLog.unknown')}</span>
        <span className="killlog__corp">{k.victimCorpName ?? ''}</span>
      </div>
      <div className="killlog__what">
        <span className="killlog__ship-name">{k.shipTypeName || t('killLog.unknownShip')}</span>
        <span className="killlog__value">{iskCompact(k.totalValue)} ISK</span>
      </div>
      <div className="killlog__where">
        <span className="killlog__system">{k.systemName}</span>
        <span className="killlog__region">{k.regionName ?? ''}</span>
      </div>
      <span className="killlog__ago">{ago}</span>
      <a
        className="killlog__zkb"
        href={zkbLink(k.killmailId)}
        target="_blank"
        rel="noopener noreferrer"
        title={t('killLog.viewOnZkb')}
        onClick={(e) => e.stopPropagation()}
      >
        <ArrowSquareOutIcon size={15} weight="regular" />
      </a>
    </div>
  );
}

export function KillLogPanel({ onClose }: Props) {
  const { t } = useTranslation();
  const activeMapId = useMapStore((s) => s.activeMapId);
  const log = useKillLog();
  const now = useNow30s();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Seed the log from the last-hour backfill on open / map change. All setState
  // happens in the async callbacks so nothing runs synchronously in the effect.
  useEffect(() => {
    if (!activeMapId) return;
    let cancelled = false;
    api<KillRow[]>(`/api/maps/${activeMapId}/kills/backfill`)
      .then((rows) => { if (!cancelled) { useKillStore.getState().seedBackfill(rows); setError(null); } })
      .catch(() => { if (!cancelled) setError(t('killLog.error')); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [activeMapId, t]);

  // Centre the map on the kill's system, then close so it isn't behind the modal.
  const onShow = (eveSystemId: number) => {
    useMapStore.getState().requestCenterOnEveSystem(eveSystemId);
    onClose();
  };

  const showLoading = loading && !!activeMapId;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal killlog-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal__header">
          <h2 className="modal__title killlog__title"><SkullIcon size={18} weight="fill" />{t('killLog.title')}</h2>
          <button className="icon-btn" onClick={onClose} aria-label={t('actions.close')}><XIcon size={16} weight="bold" /></button>
        </div>
        <div className="modal__body killlog__body">
          {showLoading && log.length === 0 && <div className="killlog__status">{t('killLog.loading')}</div>}
          {error && log.length === 0 && <div className="killlog__status killlog__status--error">{error}</div>}
          {!showLoading && !error && log.length === 0 && <div className="killlog__status">{t('killLog.empty')}</div>}
          {log.length > 0 && (
            <div className="killlog__list">
              {log.map((k) => <KillRowItem key={k.killmailId} k={k} now={now} onShow={onShow} />)}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
