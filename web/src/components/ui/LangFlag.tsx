import type { SupportedLanguage } from '../../i18n';
// Bundled SVG flags (no OS emoji font, no CDN) so flags render identically on
// Windows/Linux too — country flag emoji are absent from the Windows emoji font.
import GB from 'country-flag-icons/react/3x2/GB';
import DE from 'country-flag-icons/react/3x2/DE';
import NL from 'country-flag-icons/react/3x2/NL';
import FR from 'country-flag-icons/react/3x2/FR';
import ES from 'country-flag-icons/react/3x2/ES';
import PT from 'country-flag-icons/react/3x2/PT';
import CN from 'country-flag-icons/react/3x2/CN';
import KR from 'country-flag-icons/react/3x2/KR';
import JP from 'country-flag-icons/react/3x2/JP';
import RU from 'country-flag-icons/react/3x2/RU';

// Map each UI language to the flag that best represents it.
const FLAGS: Record<SupportedLanguage, typeof GB> = {
  en: GB, de: DE, nl: NL, fr: FR, es: ES, pt: PT, zh: CN, ko: KR, ja: JP, ru: RU,
};

export function LangFlag({ lang, className }: { lang: SupportedLanguage; className?: string }) {
  const Flag = FLAGS[lang];
  return <Flag className={className} aria-hidden="true" />;
}
