import { useTranslation } from 'react-i18next';
import { SUPPORTED_LANGUAGES, type SupportedLanguage } from '../../i18n';

// Native language names — these read the same in every locale, so they're not
// translated (English is always "English", German always "Deutsch"). Prefixed
// with a flag emoji; English uses the GB flag (the app's English is en-GB).
const LANGUAGE_NAMES: Record<SupportedLanguage, string> = {
  en: '🇬🇧 English',
  de: '🇩🇪 Deutsch',
  fr: '🇫🇷 Français',
  es: '🇪🇸 Español',
  pt: '🇵🇹 Português',
  zh: '🇨🇳 简体中文',
  ko: '🇰🇷 한국어',
  ja: '🇯🇵 日本語',
  ru: '🇷🇺 Русский',
};

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
