import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { XIcon } from '../../icons';
import { useAuth } from '../../context/AuthContext';
import { useAccountLocations } from '../../hooks/useAccountLocations';
import { setDestination, addWaypoint } from '../../api/waypoint';
import { charPortrait } from '../../utils/eveImages';
import { useSendToStore } from '../../store/sendToStore';
import styles from './SendToCharactersModal.module.css';

interface Row {
  charId:        number;   // users.id
  characterId:   number;
  characterName: string;
  online:        boolean;
  self:          boolean;
}

/**
 * Pick which of the account's characters get a destination or waypoint. Ticks
 * every logged-in one to start with; characters that aren't in game can't
 * receive one, so they're shown but can't be picked. Each character's
 * autopilot plots its own route from where it is.
 */
export function SendToCharactersModal() {
  const target = useSendToStore((s) => s.target);
  const close  = useSendToStore((s) => s.close);
  if (!target) return null;
  // Keyed so the ticks start fresh for each system it's opened for.
  return <Picker key={`${target.eveSystemId}`} eveSystemId={target.eveSystemId} name={target.name} onClose={close} />;
}

function Picker({ eveSystemId, name, onClose }: { eveSystemId: number; name: string; onClose: () => void }) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { byChar } = useAccountLocations();

  // You first, then your other characters online-first and by name. Your own
  // character is always offered: whether it's in game is the server's call,
  // and it says so in the result if not.
  const rows = useMemo<Row[]>(() => {
    const alts = [...byChar.values()]
      .map((c) => ({ charId: c.charId, characterId: c.characterId, characterName: c.characterName, online: c.online, self: false }))
      .sort((a, b) => Number(b.online) - Number(a.online) || a.characterName.localeCompare(b.characterName));
    const me: Row[] = user ? [{ charId: user.id, characterId: user.characterId, characterName: user.characterName, online: true, self: true }] : [];
    return [...me, ...alts];
  }, [byChar, user]);

  const [picked, setPicked] = useState<Set<number>>(() => new Set(rows.filter((r) => r.online).map((r) => r.charId)));
  const [sending, setSending] = useState(false);
  const anyAltOnline = rows.some((r) => !r.self && r.online);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const toggle = (charId: number) => setPicked((cur) => {
    const next = new Set(cur);
    if (next.has(charId)) next.delete(charId); else next.add(charId);
    return next;
  });

  const send = (clear: boolean) => {
    setSending(true);
    const ids = rows.filter((r) => picked.has(r.charId)).map((r) => r.charId);
    (clear ? setDestination : addWaypoint)(eveSystemId, name, ids)
      .then(onClose, () => setSending(false));   // the outcome is toasted either way
  };

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${styles.modal}`} role="dialog" aria-modal="true" aria-label={t('waypoint.sendToTitle', { system: name })}>
        <div className="modal__header">
          <h2 className="modal__title">{t('waypoint.sendToTitle', { system: name })}</h2>
          <button className="icon-btn" onClick={onClose} aria-label={t('actions.close')}>
            <XIcon size={14} weight="bold" />
          </button>
        </div>
        <div className="modal__body">
          <div className="map-sidebar__hint">{t('waypoint.sendToHint')}</div>
          <ul className={styles.list}>
            {rows.map((r) => (
              <li key={r.charId}>
                <label className={`${styles.row}${r.online ? '' : ` ${styles.offline}`}`}>
                  <input
                    type="checkbox"
                    checked={picked.has(r.charId)}
                    disabled={!r.online || sending}
                    onChange={() => toggle(r.charId)}
                  />
                  <img className={styles.portrait} src={charPortrait(r.characterId, 32)} alt="" loading="lazy" />
                  <span className={styles.name}>{r.characterName}</span>
                  {r.self && <span className={styles.tag}>{t('waypoint.you')}</span>}
                  {!r.online && <span className={styles.tag}>{t('waypoint.offline')}</span>}
                </label>
              </li>
            ))}
          </ul>
          {!anyAltOnline && <div className="map-sidebar__hint">{t('waypoint.noneOnline')}</div>}
          <div className={styles.actions}>
            <button type="button" className="btn btn--primary" disabled={picked.size === 0 || sending} onClick={() => send(true)}>
              {t('waypoint.setDestination')}
            </button>
            <button type="button" className="btn btn--ghost" disabled={picked.size === 0 || sending} onClick={() => send(false)}>
              {t('waypoint.addWaypoint')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
