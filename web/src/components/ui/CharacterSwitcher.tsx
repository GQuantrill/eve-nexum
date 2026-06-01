import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CaretDownIcon, PlusIcon, CheckIcon } from '@phosphor-icons/react';
import { useAuth } from '../../context/AuthContext';
import { api, apiUrl } from '../../api/client';

/**
 * Account character switcher. Lists every character linked to the signed-in
 * account; clicking one makes it active (no SSO — its token is already stored)
 * and reloads so map/corp context re-initialises. "Add character" runs the
 * authenticated add-character SSO flow on the server.
 */
export function CharacterSwitcher() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  if (!user) return null;
  const characters = user.characters ?? [];

  async function switchTo(userId: number) {
    if (busy) return;
    setBusy(true);
    try {
      await api('/auth/switch-character', { method: 'POST', body: JSON.stringify({ userId }) });
      // Full reload so maps, corp access and all per-character context re-init.
      window.location.reload();
    } catch {
      setBusy(false);
      setOpen(false);
    }
  }

  return (
    <div className="character-switcher" ref={wrapRef}>
      <button
        type="button"
        className="character-switcher__trigger"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        data-tooltip={t('account.switchCharacter')}
        aria-label={t('account.switchCharacter')}
      >
        <CaretDownIcon size={14} weight="bold" />
      </button>
      {open && (
        <div className="character-switcher__menu" role="menu">
          {characters.map((c) => (
            <button
              key={c.id}
              type="button"
              role="menuitem"
              className={`character-switcher__item${c.active ? ' character-switcher__item--active' : ''}`}
              disabled={busy || c.active || c.blocked}
              onClick={() => switchTo(c.id)}
            >
              <img
                className="character-switcher__avatar"
                src={`https://images.evetech.net/characters/${c.characterId}/portrait?size=32`}
                alt=""
              />
              <span className="character-switcher__name">
                {c.characterName}
                {c.blocked && <span className="character-switcher__blocked">{t('account.blocked')}</span>}
              </span>
              {c.active && <CheckIcon size={13} weight="bold" />}
            </button>
          ))}
          <a className="character-switcher__add" href={apiUrl('/auth/add-character')}>
            <PlusIcon size={13} weight="bold" />
            {t('account.addCharacter')}
          </a>
        </div>
      )}
    </div>
  );
}
