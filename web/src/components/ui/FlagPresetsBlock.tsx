import { useTranslation } from 'react-i18next';
import { FlagPresetEditor } from './FlagPresetEditor';
import { useFlagPresets } from '../../hooks/useFlagPresets';

/**
 * The pilot's own connection-flag presets, in the Connections section beside
 * the other connection settings. Writes straight through the user setting, so
 * there is no save button -- same as the custom-intel editor above it.
 */
export function FlagPresetsBlock() {
  const { t } = useTranslation();
  const [items, setItems] = useFlagPresets();

  return (
    <>
      <div className="map-sidebar__label">{t('flagPresets.title')}</div>
      <div className="map-sidebar__hint">{t('flagPresets.hint')}</div>
      <FlagPresetEditor items={items} onChange={setItems} />
    </>
  );
}
