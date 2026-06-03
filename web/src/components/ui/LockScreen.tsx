import { useTranslation } from 'react-i18next';
import type { AuthUser } from '../../context/AuthContext';

/**
 * Idle-lock screen. Shown when the session is still valid but the UI has been
 * paused for inactivity. "Continue" resumes in place — no SSO, no re-picking
 * the character — because the session never ended.
 */
export function LockScreen({
  user,
  onResume,
  onLogout,
}: {
  user: AuthUser;
  onResume: () => void;
  onLogout: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="lock-screen">
      <div className="lock-screen__card">
        <img
          className="lock-screen__avatar"
          src={`https://images.evetech.net/characters/${user.characterId}/portrait?size=128`}
          alt=""
        />
        <h1 className="lock-screen__title">{t('session.lockedTitle')}</h1>
        <p className="lock-screen__hint">{t('session.lockedHint')}</p>
        <button type="button" className="lock-screen__resume" onClick={onResume} autoFocus>
          {t('session.resumeAs', { name: user.characterName })}
        </button>
        <button type="button" className="lock-screen__logout" onClick={onLogout}>
          {t('session.logOut')}
        </button>
      </div>
    </div>
  );
}
