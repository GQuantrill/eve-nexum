import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '../api/client';
import type { StoredScan } from '../utils/dscanView';

export type ScanLoad =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ok'; scan: StoredScan };

/**
 * Load one d-scan by id. The result is tagged with the id it belongs to, so
 * switching to another scan reads as loading straight away instead of briefly
 * showing the previous one.
 */
export function useScan(id: string): ScanLoad {
  const { t } = useTranslation();
  const [state, setState] = useState<{ id: string; load: ScanLoad } | null>(null);

  useEffect(() => {
    let live = true;
    api<StoredScan>(`/api/dscan/${id}`)
      .then((scan) => { if (live) setState({ id, load: { status: 'ok', scan } }); })
      .catch((err) => {
        if (!live) return;
        const status = err instanceof ApiError ? err.status : 0;
        setState({
          id,
          load: {
            status: 'error',
            message: status === 404 ? t('dscan.errors.notFound')
              : status === 410 ? t('dscan.errors.expired')
              : t('dscan.errors.loadFailed'),
          },
        });
      });
    return () => { live = false; };
  }, [id, t]);

  return state?.id === id ? state.load : { status: 'loading' };
}
