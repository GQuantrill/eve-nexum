import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { isHydrated, readUserSetting, writeUserSetting } from '../../hooks/useUserSetting';
import { ANN } from '../../hooks/useAnnouncerEvents';
import { ANNOUNCER_DOWNLOAD_MB } from '../../audio/announcer';
import { proximityPromptPending } from '../../utils/firstRunPrompts';
import styles from './ProximityOptInModal.module.css';

/**
 * One-time question: turn the voice announcer on? The announcer is opt-in (it
 * talks, and its first use downloads the voice model), so nobody hears it or
 * downloads it without saying yes. Asked once per user, on any device (the
 * answer is a synced setting); it can be changed later in the Announcer section.
 *
 * Waits until the saved settings have loaded (they're seeded by MapApp's own
 * effect, which runs after this one) and until the threat-alert prompt has been
 * answered, so two prompts never open at once. Skipped for anyone who already
 * has the announcer on.
 */
export function AnnouncerOptInModal() {
  const { t } = useTranslation();
  const [show, setShow] = useState(false);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const check = () => {
      timer = null;
      if (!isHydrated() || proximityPromptPending()) { timer = setTimeout(check, 1000); return; }
      if (readUserSetting<boolean>(ANN.asked, false)) return;
      if (readUserSetting<boolean>(ANN.enabled, false)) { writeUserSetting(ANN.asked, true); return; }
      setShow(true);
    };
    timer = setTimeout(check, 1000);
    return () => { if (timer) clearTimeout(timer); };
  }, []);

  function answer(on: boolean) {
    writeUserSetting(ANN.asked, true);
    if (on) writeUserSetting(ANN.enabled, true);
    setShow(false);
  }

  if (!show) return null;

  return createPortal(
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) answer(false); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="announcer-optin-title">
        <div className="modal__header">
          <h2 className="modal__title" id="announcer-optin-title">{t('announcerOptIn.title')}</h2>
        </div>
        <div className={`modal__body ${styles.body}`}>
          <p>{t('announcerOptIn.body')}</p>
          {ANNOUNCER_DOWNLOAD_MB !== null && (
            <p>{t('announcerOptIn.download', { mb: ANNOUNCER_DOWNLOAD_MB })}</p>
          )}
          <p className={styles.sub}>
            {t('announcerOptIn.sub', { section: t('mapSidebar.sections.announcer') })}
          </p>
          <div className="modal__actions">
            <button type="button" className="btn btn--ghost" onClick={() => answer(false)}>
              {t('announcerOptIn.noThanks')}
            </button>
            <button type="button" className="btn btn--primary" onClick={() => answer(true)}>
              {t('announcerOptIn.enable')}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
