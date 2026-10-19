import { useTranslation } from 'react-i18next';
import { useOrgIds } from '../../hooks/useOrgLogos';
import { allianceLogo, corpLogo } from '../../utils/eveImages';

/**
 * Logos of the alliance(s) and corp(s) a restricted deployment is run for --
 * alliance first, as the wider group. Renders nothing on an open deployment.
 */
export function OrgLogos({ className, size }: { className: string; size: number }) {
  const { t } = useTranslation();
  const org = useOrgIds();
  // Tolerate a malformed payload (e.g. an older server) rather than crash the
  // toolbar over a cosmetic logo.
  const corpIds     = Array.isArray(org?.corpIds) ? org.corpIds : [];
  const allianceIds = Array.isArray(org?.allianceIds) ? org.allianceIds : [];
  if (corpIds.length === 0 && allianceIds.length === 0) return null;

  // Ask CCP's image server for 2x the display size so logos stay sharp on
  // high-DPI screens; it only serves power-of-two sizes.
  const fetchSize = size > 32 ? 128 : 64;

  return (
    <div className={className}>
      {allianceIds.map((id) => (
        <img key={`a${id}`} src={allianceLogo(id, fetchSize)} alt={t('orgLogos.alliance')} width={size} height={size} />
      ))}
      {corpIds.map((id) => (
        <img key={`c${id}`} src={corpLogo(id, fetchSize)} alt={t('orgLogos.corp')} width={size} height={size} />
      ))}
    </div>
  );
}
