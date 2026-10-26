import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../context/AuthContext';
import { LanguageSwitcher } from '../ui/LanguageSwitcher';
import { DscanPaste } from './DscanPaste';
import { DscanResult, ScanLinkBar } from './DscanResult';
import { useScan } from '../../hooks/useScan';
import styles from './Dscan.module.css';

/**
 * The public d-scan page: #/dscan to paste, #/dscan/<id> to view. Reached from
 * the landing page and by anyone holding a scan link, so it renders whether
 * or not the visitor is logged in.
 */
export function DscanPage({ id }: { id?: string }) {
  const { t } = useTranslation();
  const { user } = useAuth();

  useEffect(() => {
    const prev = document.title;
    document.title = `${t('dscan.title')} - nexum`;
    return () => { document.title = prev; };
  }, [t]);

  return (
    <div className={styles.page}>
      <div className={styles.pageInner}>
        <header className={styles.pageHeader}>
          <img className={styles.pageLogo} src="/screen.png" alt="" />
          <h1 className={styles.pageTitle}>{t('dscan.title')}</h1>
          <LanguageSwitcher />
          {/* "/" is the map when logged in and the landing page when not. */}
          <a className={styles.homeLink} href="#/">{user ? t('dscan.backToMap') : t('dscan.home')}</a>
        </header>
        {id ? <ScanView id={id} /> : (
          <DscanPaste onCreated={(newId) => { window.location.hash = `#/dscan/${newId}`; }} />
        )}
      </div>
    </div>
  );
}

function ScanView({ id }: { id: string }) {
  const { t } = useTranslation();
  const state = useScan(id);
  return (
    <>
      <div className={styles.pasteActions}>
        <a className="btn btn--ghost" href="#/dscan">{t('dscan.newScan')}</a>
      </div>
      {state.status === 'loading' && <p className={styles.empty}>{t('dscan.loading')}</p>}
      {state.status === 'error' && <p className={styles.error}>{state.message}</p>}
      {state.status === 'ok' && (
        <>
          <ScanLinkBar id={id} />
          <DscanResult scan={state.scan} />
        </>
      )}
    </>
  );
}
