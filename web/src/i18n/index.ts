import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

import enCommon from './locales/en/common.json';
import deCommon from './locales/de/common.json';
import frCommon from './locales/fr/common.json';
import esCommon from './locales/es/common.json';
import ptCommon from './locales/pt/common.json';

// Languages we ship translations for. Add a code here AND a matching
// locales/<code>/common.json file to add a language. Native language names
// live in the LanguageSwitcher (they read the same in every locale).
export const SUPPORTED_LANGUAGES = ['en', 'de', 'fr', 'es', 'pt'] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

// One namespace ('common') for now. Split into feature namespaces
// (sidebar, toolbar, admin, …) as the string count grows.
export const resources = {
  en: { common: enCommon },
  de: { common: deCommon },
  fr: { common: frCommon },
  es: { common: esCommon },
  pt: { common: ptCommon },
} as const;

// NOTE: EVE game data (system names, ship types, wormhole codes like C1/HS/K162)
// is canonical English and is NOT translated — only app chrome goes through i18n.
void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    fallbackLng: 'en',
    supportedLngs: SUPPORTED_LANGUAGES,
    // Map regional browser locales to the base language we ship, so a visitor
    // whose browser reports e.g. es-ES / es-MX / en-GB / fr-CA / de-AT is
    // auto-detected as es / en / fr / de rather than missing and falling back
    // to English. (`load` strips the region from the resolved language; the
    // navigator detector still reads navigator.languages in priority order.)
    load: 'languageOnly',
    nonExplicitSupportedLngs: true,
    defaultNS: 'common',
    ns: ['common'],
    detection: {
      // Prefer a previously chosen language, else the browser's; persist the choice.
      order: ['localStorage', 'navigator'],
      lookupLocalStorage: 'nexum.lang',
      caches: ['localStorage'],
    },
    interpolation: { escapeValue: false }, // React already escapes output
    returnNull: false,
    // <Trans> renders these inline tags straight from the locale string (no
    // `components` prop needed) — used for the few sentences with embedded
    // <strong>/<em> emphasis.
    react: { transKeepBasicHtmlNodesFor: ['br', 'strong', 'i', 'em', 'p'] },
  });

export default i18n;
