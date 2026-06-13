import { useRef, useState } from 'react';
import { useClickOutside } from '../../hooks/useClickOutside';
import { charPortrait } from '../../utils/eveImages';
import { useTranslation } from 'react-i18next';
import { CaretDownIcon, PlusIcon, CheckIcon, MapPinIcon, TrashIcon } from '@phosphor-icons/react';
import { useAuth } from '../../context/AuthContext';
import { useMapStore } from '../../store/mapStore';
import { api, apiUrl } from '../../api/client';
import { toast } from './Toaster';
import { ConfirmModal } from './ConfirmModal';

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
  const { user, refresh } = useAuth();
  const routeOrigin = useMapStore((s) => s.routeOrigin);
  const setRouteOrigin = useMapStore((s) => s.setRouteOrigin);
  const requestCenter = useMapStore((s) => s.requestCenterOnEveSystem);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pendingRemove, setPendingRemove] = useState<{ id: number; characterName: string } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  useClickOutside(open, wrapRef, () => setOpen(false));

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

  // Unlink an alt from the account. The server forbids removing the active
  // character, so this only ever runs for the others. Refresh the list in
  // place and drop any route-origin override that pointed at it.
  async function removeChar(c: { id: number; characterName: string }) {
    if (busy) return;
    setBusy(true);
    try {
      await api('/auth/remove-character', { method: 'POST', body: JSON.stringify({ userId: c.id }) });
      if (routeOrigin?.charId === c.id) setRouteOrigin(null);
      toast.success(t('account.characterRemoved', { name: c.characterName }));
      await refresh();
    } catch {
      toast.error(t('account.removeFailed'));
    } finally {
      setBusy(false);
      setPendingRemove(null);
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
                    src={charPortrait(c.characterId, 32)}
                    alt=""
                  />
                  <span className="character-switcher__identity">
                    <span className="character-switcher__name">
                      {c.characterName}
                      {c.blocked && <span className="character-switcher__blocked">{t('account.blocked')}</span>}
                    </span>
                    <span className="character-switcher__location">
                      {c.lastKnownSystemName
                        ? (c.lastKnownSystemClass
                            ? `${c.lastKnownSystemName} · ${c.lastKnownSystemClass}`
                            : c.lastKnownSystemName)
                        : t('account.locationUnknown')}
                    </span>
                  </span>
                  {c.active && <CheckIcon size={13} weight="bold" />}
                </button>
                {c.active ? (
                  <span className="character-switcher__remove-spacer" aria-hidden="true" />
                ) : (
                  <button
                    type="button"
                    className="character-switcher__remove"
                    disabled={busy}
                    onClick={() => setPendingRemove({ id: c.id, characterName: c.characterName })}
                    data-tooltip={t('account.removeCharacter', { name: c.characterName })}
                    aria-label={t('account.removeCharacter', { name: c.characterName })}
                  >
                    <TrashIcon size={14} />
                  </button>
                )}
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
      {pendingRemove && (
        <ConfirmModal
          message={t('account.removeConfirm', { name: pendingRemove.characterName })}
          confirmLabel={t('account.remove')}
          showDontAskAgain={false}
          onConfirm={() => removeChar(pendingRemove)}
          onCancel={() => setPendingRemove(null)}
        />
      )}
    </div>
  );
}
