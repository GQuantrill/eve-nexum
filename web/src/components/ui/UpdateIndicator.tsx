import { useTranslation } from 'react-i18next';
import { WarningIcon } from '@phosphor-icons/react';
import { useUpdateCheck } from '../../hooks/useUpdateCheck';

// Blinking red badge (admins + alliance admins only) shown when a newer upstream
// release exists. Hover shows the version; click opens the GitHub release. Self-
// gates via useUpdateCheck, so it renders nothing for non-admins / when current.
export function UpdateIndicator() {
  const { t } = useTranslation();
  const { updateAvailable, latest, releaseUrl } = useUpdateCheck();
  if (!updateAvailable || !releaseUrl) return null;

  const label = latest
    ? t('toolbar.updateAvailableVersion', { version: latest })
    : t('toolbar.updateAvailable');

  return (
    <button
      type="button"
      className="toolbar__update"
      onClick={() => window.open(releaseUrl, '_blank', 'noopener,noreferrer')}
      data-tooltip={label}
      aria-label={label}
    >
      <WarningIcon size={18} weight="fill" />
    </button>
  );
}
