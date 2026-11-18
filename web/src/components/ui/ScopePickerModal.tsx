import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { loginUrl, useScopeOptions } from '../../api/scopeOptions';
import { useEscapeClose } from '../../hooks/useEscapeClose';
import { useAuth } from '../../context/AuthContext';
import {
  SCOPE_GROUP_IDS, useScopePickerStore, type ScopeGroupId, type ScopePickerTarget,
} from '../../store/scopePickerStore';
import styles from './ScopePickerModal.module.css';

// Ticked when the picker opens: everything for a new login or character; for a
// change, what the character holds now plus the group a feature asked for.
function initialTicks(target: ScopePickerTarget, held: readonly string[]): Set<string> {
  if (target.kind === 'login' && target.ticked) return new Set(target.ticked);
  if (target.kind !== 'change') return new Set(SCOPE_GROUP_IDS);
  return new Set([...held, ...(target.require ? [target.require] : [])]);
}

/**
 * "Choose what nexum can access": each ESI scope group, what nexum reads with
 * it, and what it's used for. Location is always required (and so is anything
 * the operator hasn't made optional); the rest can be unticked. In 'all' mode
 * nothing can be unticked and the picker just explains, with a button to log in
 * again.
 */
export function ScopePickerModal() {
  const target = useScopePickerStore((s) => s.target);
  const close = useScopePickerStore((s) => s.close);
  if (!target) return null;
  // Keyed so each opening starts from its own ticks.
  return <Picker key={JSON.stringify(target)} target={target} onClose={close} />;
}

function Picker({ target, onClose }: { target: ScopePickerTarget; onClose: () => void }) {
  const { t } = useTranslation();
  useEscapeClose(onClose);
  const options = useScopeOptions();
  const { user } = useAuth();
  // The character being changed: the one asked for, else the signed-in one.
  const account = target.kind === 'change'
    ? user?.characters.find((c) => (target.charId != null ? c.id === target.charId : c.active))
    : undefined;
  const characterName = account?.characterName ?? user?.characterName ?? '';
  const held = account?.scopeGroups ?? user?.scopeGroups ?? SCOPE_GROUP_IDS;
  const [ticked, setTicked] = useState<Set<string>>(() => initialTicks(target, held));
  const choice = options?.mode === 'choice';

  const toggle = (id: ScopeGroupId) => setTicked((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const title = target.kind === 'change'
    ? t('scopes.titleChange', { name: characterName })
    : target.kind === 'add' ? t('scopes.titleAdd') : t('scopes.titleLogin');

  return createPortal(
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`modal ${styles.modal}`} role="dialog" aria-modal="true" aria-labelledby="scope-picker-title">
        <div className="modal__header">
          <h2 className="modal__title" id="scope-picker-title">{title}</h2>
        </div>
        <div className={`modal__body ${styles.body}`}>
          <p className={styles.intro}>{choice ? t('scopes.introChoice') : t('scopes.introAll')}</p>
          {!options ? (
            <p className={styles.intro}>{t('scopes.loading')}</p>
          ) : (
            <ul className={styles.list}>
              {options.groups.map((g) => {
                const locked = !choice || !g.optional;
                const on = locked || ticked.has(g.id);
                const asked = target.kind === 'change' && target.require === g.id;
                return (
                  <li key={g.id} className={`${styles.group}${asked ? ` ${styles.asked}` : ''}${on ? '' : ` ${styles.off}`}`}>
                    <label className={styles.head}>
                      <input
                        type="checkbox"
                        className="sig-checkbox"
                        checked={on}
                        disabled={locked}
                        onChange={() => toggle(g.id)}
                      />
                      <span className={styles.name}>{t(`scopes.groups.${g.id}.title`)}</span>
                      {choice && !g.optional && <span className={styles.badge}>{t('scopes.required')}</span>}
                    </label>
                    <p className={styles.desc}>{t(`scopes.groups.${g.id}.desc`)}</p>
                    <p className={styles.affects}>
                      <span className={styles.affectsLabel}>{t('scopes.usedFor')}</span>{' '}
                      {t(`scopes.groups.${g.id}.affects`)}
                    </p>
                  </li>
                );
              })}
            </ul>
          )}
          {choice && <p className={styles.note}>{t('scopes.changeLater')}</p>}
          <div className="modal__actions">
            <button className="btn btn--ghost" onClick={onClose}>{t('actions.cancel')}</button>
            <button
              className="btn btn--primary"
              disabled={!options}
              onClick={() => { window.location.assign(loginUrl(target, options, ticked)); }}
            >
              {choice ? t('scopes.continue') : t('scopes.loginAgain')}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
