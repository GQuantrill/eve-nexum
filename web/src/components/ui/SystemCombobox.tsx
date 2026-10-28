import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { MapSystem } from '../../types';
import { systemDisplayName } from '../../utils/systemName';
import { Combobox } from './Combobox';

interface Props {
  systems: MapSystem[];
  value: string;                  // selected system id, or '' for none
  onChange: (id: string) => void;
  placeholder: string;
  excludeId?: string;             // omit this id from results (the other endpoint)
}

// Searchable single-select over the systems already on the map. Filters local
// map systems instead of hitting ESI — so a big map doesn't render a giant
// native <select>.
export function SystemCombobox({ systems, value, onChange, placeholder, excludeId }: Props) {
  const { t } = useTranslation();
  const options = useMemo(() => systems
    .filter((s) => s.id !== excludeId)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((s) => ({ value: s.id, label: systemDisplayName(s), search: s.name, hint: s.systemClass })),
  [systems, excludeId]);
  return (
    <Combobox
      options={options}
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      noMatchText={t('chains.noMatch')}
      clearLabel={t('chains.clearSelection')}
    />
  );
}
