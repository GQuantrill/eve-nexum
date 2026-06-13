import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CaretDownIcon, CheckIcon } from '@phosphor-icons/react';
import { SUPPORTED_LANGUAGES, LANGUAGE_NAMES, type SupportedLanguage } from '../../i18n';
import { useClickOutside } from '../../hooks/useClickOutside';
import { LangFlag } from './LangFlag';

// Custom dropdown (not a native <select>) because native <option>s can't render
// the bundled SVG flags — only plain text. Mirrors the CharacterSwitcher menu.
export function LanguageSwitcher() {
  const { t, i18n } = useTranslation();
  const current = (i18n.resolvedLanguage ?? 'en') as SupportedLanguage;
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useClickOutside(open, wrapRef, () => setOpen(false));

  const choose = (lng: SupportedLanguage) => {
    void i18n.changeLanguage(lng);
    setOpen(false);
  };

  return (
    <div className="lang-switcher" ref={wrapRef}>
      <button
        type="button"
        className="lang-switcher__trigger"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        data-tooltip={t('language.label')}
        aria-label={t('language.label')}
      >
        <LangFlag lang={current} className="lang-switcher__flag" />
        <span className="lang-switcher__current">{LANGUAGE_NAMES[current]}</span>
        <CaretDownIcon size={12} weight="bold" />
      </button>
      {open && (
        <div className="lang-switcher__menu" role="listbox" aria-label={t('language.label')}>
          {SUPPORTED_LANGUAGES.map((lng) => (
            <button
              key={lng}
              type="button"
              role="option"
              aria-selected={lng === current}
              className={`lang-switcher__option${lng === current ? ' lang-switcher__option--active' : ''}`}
              onClick={() => choose(lng)}
            >
              <LangFlag lang={lng} className="lang-switcher__flag" />
              <span className="lang-switcher__option-name">{LANGUAGE_NAMES[lng]}</span>
              {lng === current && <CheckIcon size={13} weight="bold" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
