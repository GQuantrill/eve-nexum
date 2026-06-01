import { useTranslation } from 'react-i18next';
import { SUPPORTED_LANGUAGES, LANGUAGE_NAMES, type SupportedLanguage } from '../../i18n';

export function LanguageSwitcher() {
  const { t, i18n } = useTranslation();
  const current = (i18n.resolvedLanguage ?? 'en') as SupportedLanguage;

  return (
    <select
      className="toolbar__lang-select"
      value={current}
      onChange={(e) => { void i18n.changeLanguage(e.target.value); }}
      data-tooltip={t('language.label')}
      aria-label={t('language.label')}
    >
      {SUPPORTED_LANGUAGES.map((lng) => (
        <option key={lng} value={lng}>{LANGUAGE_NAMES[lng]}</option>
      ))}
    </select>
  );
}
