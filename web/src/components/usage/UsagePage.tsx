import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '../../api/client';
import { LanguageSwitcher } from '../ui/LanguageSwitcher';
import { UsageView, type UsageReport } from './UsageView';
import styles from './Usage.module.css';

/** The public usage page, #/usage/<token>: the shareable link made in the
 *  admin Reports tab. No sign-in. */
export function UsagePage({ token }: { token: string }) {
  const { t } = useTranslation();
  const [state, setState] = useState<{ report?: UsageReport; error?: 'notFound' | 'failed' }>({});

  useEffect(() => {
    const prev = document.title;
    document.title = `${t('usage.title')} - nexum`;
    return () => { document.title = prev; };
  }, [t]);

  useEffect(() => {
    let cancelled = false;
    api<{ report: UsageReport }>(`/api/usage/${encodeURIComponent(token)}`)
      .then((r) => { if (!cancelled) setState({ report: r.report }); })
      .catch((err: unknown) => {
        if (!cancelled) setState({ error: err instanceof ApiError && err.status === 404 ? 'notFound' : 'failed' });
      });
    return () => { cancelled = true; };
  }, [token]);

  return (
    <div className={styles.page}>
      <div className={styles.pageInner}>
        <header className={styles.pageHeader}>
          <img className={styles.pageLogo} src="/screen.png" alt="" />
          <div className={styles.pageHeading}>
            <h1 className={styles.pageTitle}>{t('usage.title')}</h1>
            <p className={styles.pageSub}>{t('usage.subtitle')}</p>
          </div>
          <LanguageSwitcher />
        </header>
        {state.report && <UsageView report={state.report} />}
        {!state.report && !state.error && <p className={styles.empty}>{t('usage.loading')}</p>}
        {state.error && <p className={styles.empty}>{t(state.error === 'notFound' ? 'usage.notFound' : 'usage.failed')}</p>}
      </div>
    </div>
  );
}
