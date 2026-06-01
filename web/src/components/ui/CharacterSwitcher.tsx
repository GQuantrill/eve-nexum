import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CaretDownIcon, PlusIcon, CheckIcon, MapPinIcon } from '@phosphor-icons/react';
import { useAuth } from '../../context/AuthContext';
import { useMapStore } from '../../store/mapStore';
import { api, apiUrl } from '../../api/client';
import { toast } from './Toaster';

interface CharLocationResponse {
  online: boolean;
  system: { eveSystemId: number; name: string; systemClass: string | null } | null;
}

/**
 * Account character switcher. Lists every character linked to the signed-in
 * account. Clicking a row makes it active (no SSO — its token is already
 * stored) and reloads so map/corp context re-inits. The 📍 button focuses the
 * map + jump calcs on that character's location WITHOUT switching active — e.g.
 * route from a scout sitting on the chain exit while you fly your main out.
 * "Add character" runs the authenticated add-character SSO flow.
 */
export function CharacterSwitcher() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const routeOrigin = useMapStore((s) => s.routeOrigin);
  const setRouteOrigin = useMapStore((s) => s.setRouteOrigin);
  const requestCenter = useMapStore((s) => s.requestCenterOnEveSystem);
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

  // Point centring + jump calcs at this character's location (live if online,
  // else its last known system). The active character clears the override and
  // reverts to live routing.
  async function focusOn(c: typeof characters[number]) {
    if (busy) return;
    setBusy(true);
    try {
      const loc = await api<CharLocationResponse>(`/api/character/${c.id}/location`).catch(() => null);
      let eveSystemId: number | null = null;
      let systemName = '';
      let systemClass: string | null = null;
      if (loc?.online && loc.system) {
        eveSystemId = loc.system.eveSystemId; systemName = loc.system.name; systemClass = loc.system.systemClass;
      } else if (c.lastKnownSystemId != null) {
        eveSystemId = c.lastKnownSystemId; systemName = c.lastKnownSystemName ?? ''; systemClass = c.lastKnownSystemClass;
      }
      if (eveSystemId == null) {
        toast.error(t('account.noLocation', { name: c.characterName }));
        return;
      }
      setRouteOrigin(c.active
        ? null
        : { charId: c.id, characterName: c.characterName, eveSystemId, systemName, systemClass });
      requestCenter(eveSystemId);
    } finally {
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
          {characters.map((c) => {
            const isOrigin = routeOrigin ? routeOrigin.charId === c.id : c.active;
            return (
              <div key={c.id} className={`character-switcher__row${c.active ? ' character-switcher__row--active' : ''}`}>
                <button
                  type="button"
                  role="menuitem"
                  className="character-switcher__switch"
                  disabled={busy || c.active || c.blocked}
                  onClick={() => switchTo(c.id)}
                  data-tooltip={c.active ? undefined : t('account.switchTo', { name: c.characterName })}
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
                <button
                  type="button"
                  className={`character-switcher__focus${isOrigin ? ' character-switcher__focus--on' : ''}`}
                  disabled={busy || c.blocked}
                  onClick={() => focusOn(c)}
                  data-tooltip={t('account.focusLocation', { name: c.characterName })}
                  aria-label={t('account.focusLocation', { name: c.characterName })}
                >
                  <MapPinIcon size={14} weight={isOrigin ? 'fill' : 'regular'} />
                </button>
              </div>
            );
          })}
          <a className="character-switcher__add" href={apiUrl('/auth/add-character')}>
            <PlusIcon size={13} weight="bold" />
            {t('account.addCharacter')}
          </a>
        </div>
      )}
    </div>
  );
}
