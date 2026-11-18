import { useTranslation } from 'react-i18next';
import { useScopePickerStore, type ScopeGroupId } from '../../store/scopePickerStore';
import styles from './ScopeNeeded.module.css';

/**
 * Shown where a feature would be when the signed-in character hasn't allowed
 * the access it needs: names the access and offers to enable it, rather than
 * looking empty or blaming something else. Enable opens the picker for this
 * character with that group ticked.
 */
export function ScopeNeeded({ group }: { group: ScopeGroupId }) {
  const { t } = useTranslation();
  const open = useScopePickerStore((s) => s.open);
  return (
    <div className={styles.note}>
      <span>{t('scopes.needsSelf', { group: t(`scopes.groups.${group}.title`) })}</span>
      <button type="button" className="btn btn--primary btn--sm" onClick={() => open({ kind: 'change', require: group })}>
        {t('scopes.enable')}
      </button>
    </div>
  );
}
