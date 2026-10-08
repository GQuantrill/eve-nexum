import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

import enCommon from './locales/en/common.json';

// Languages we ship translations for. Add a code here AND a matching
// locales/<code>/common.json file to add a language. Native language names
// live in the LanguageSwitcher (they read the same in every locale).
export const SUPPORTED_LANGUAGES = ['en', 'de', 'fr', 'es', 'pt', 'zh', 'ko', 'ja', 'ru'] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

// Native language names, each prefixed with a flag emoji. These read the same
// in every locale (English is always "English", Deutsch always "Deutsch") so
// they are NOT translated. English uses the GB flag (the app's English is
// en-GB). Used by the LanguageSwitcher and the landing-page language section.
// Native language names. Flags are rendered separately as bundled SVGs (see
// LangFlag) rather than emoji, since Windows has no country-flag glyphs.
export const LANGUAGE_NAMES: Record<SupportedLanguage, string> = {
  en: 'English',
  de: 'Deutsch',
  fr: 'Français',
  es: 'Español',
  pt: 'Português',
  zh: '简体中文',
  ko: '한국어',
  ja: '日本語',
  ru: 'Русский',
};

// One namespace ('common') for now. Split into feature namespaces
// (sidebar, toolbar, admin, …) as the string count grows.
// Only English is bundled with the app. The other eight are a dynamic import
// each, fetched for the one language a given person actually reads -- see
// ensureLanguage below. Shipping all nine cost ~339K gzipped on every load to
// serve ~40K of it.
//
// English stays static on purpose: it is the fallback for any key a
// translation is missing, so it has to be present before the first render,
// and i18next.d.ts types t() against this object.
export const resources = {
  en: { common: enCommon },
} as const;

// NOTE: EVE game data (system names, ship types, wormhole codes like C1/HS/K162)
// is canonical English and is NOT translated — only app chrome goes through i18n.
// One dynamic import per language. Written out rather than built from a
// template literal so the bundler can see each path and give it its own chunk.
const LOADERS: Record<string, () => Promise<{ default: object }>> = {
  de: () => import('./locales/de/common.json'),
  fr: () => import('./locales/fr/common.json'),
  es: () => import('./locales/es/common.json'),
  pt: () => import('./locales/pt/common.json'),
  zh: () => import('./locales/zh/common.json'),
  ko: () => import('./locales/ko/common.json'),
  ja: () => import('./locales/ja/common.json'),
  ru: () => import('./locales/ru/common.json'),
};

const loaded = new Map<string, Promise<void>>();

/**
 * Make sure a language's strings are in memory.
 *
 * Idempotent and safe to call for 'en' or an unknown code, both of which
 * resolve immediately. Callers await it BEFORE switching language, so the UI
 * never renders a half-translated frame; a failed chunk resolves rather than
 * rejecting, leaving the English fallback in place, because a missing
 * translation should not take the app down.
 */
export function ensureLanguage(lng: string): Promise<void> {
  const base = (lng || '').split('-')[0];
  const load = LOADERS[base];
  if (!load) return Promise.resolve();
  let p = loaded.get(base);
  if (!p) {
    p = load()
      .then((m) => { i18n.addResourceBundle(base, 'common', m.default, true, true); })
      .catch(() => { /* keep English rather than failing the app */ });
    loaded.set(base, p);
  }
  return p;
}

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
