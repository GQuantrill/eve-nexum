import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { useAuth } from '../../context/AuthContext';
import { GasPumpIcon } from '@phosphor-icons/react';

interface CorpStructure {
  structure_id: number;
  name: string;
  system_name: string;
  fuel_expires: string | null;
}

export function FuelAlertChip() {
  const { user } = useAuth();
  const [nearest, setNearest] = useState<{ name: string; systemName: string; hoursLeft: number } | null>(null);

  useEffect(() => {
    if (!user?.corpMode) return;

    function poll() {
      api<CorpStructure[]>('/api/corp-structures')
        .then((structures) => {
          let min: typeof nearest = null;
          for (const s of structures) {
            if (!s.fuel_expires) continue;
            const hoursLeft = (new Date(s.fuel_expires).getTime() - Date.now()) / (1000 * 60 * 60);
            if (hoursLeft > 0 && (!min || hoursLeft < min.hoursLeft)) {
              min = { name: s.name, systemName: s.system_name, hoursLeft };
            }
          }
          setNearest(min);
        })
        .catch(() => setNearest(null));
    }

    poll();
    const interval = setInterval(poll, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [user?.corpMode]);

  if (!nearest) return null;

  const days = Math.floor(nearest.hoursLeft / 24);
  const hours = Math.round(nearest.hoursLeft % 24);
  const label = days > 0 ? `${days}d ${hours}h` : `${hours}h`;

  const urgency =
    nearest.hoursLeft <= 24 ? 'fuel-chip--critical' :
    nearest.hoursLeft <= 72 ? 'fuel-chip--warning' :
    'fuel-chip--caution';

  return (
    <span
      className={`toolbar__chip fuel-chip ${urgency}`}
      data-tooltip={`${nearest.name} in ${nearest.systemName} — ${label} fuel left`}
    >
      <GasPumpIcon size={14} weight="fill" />
      <span className="fuel-chip__label">Fuel: {label}</span>
    </span>
  );
}
