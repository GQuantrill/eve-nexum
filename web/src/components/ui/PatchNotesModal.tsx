import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { XIcon } from '@phosphor-icons/react';
import MDEditor from '@uiw/react-md-editor';
import rehypeSanitize from 'rehype-sanitize';
import { api } from '../../api/client';

interface ReleaseNote {
  version:     string;
  name:        string;
  body:        string;
  url:         string;
  publishedAt: string | null;
}

// Shows the last 10 upstream releases' notes. Fetched from the server-cached
// /api/releases; the body is release-authored markdown, rendered sanitised.
export function PatchNotesModal({ onClose }: { onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const [releases, setReleases] = useState<ReleaseNote[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api<ReleaseNote[]>('/api/releases')
      .then((r) => { if (!cancelled) setReleases(r); })
      .catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const fmtDate = (iso: string | null): string => {
    if (!iso) return '';
    const d = new Date(iso);
    return Number.isFinite(d.getTime())
      ? d.toLocaleDateString(i18n.language, { year: 'numeric', month: 'short', day: 'numeric' })
      : '';
  };

  return createPortal(
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal patchnotes" role="dialog" aria-modal="true">
        <div className="modal__header">
          <h2 className="modal__title">{t('mapSidebar.patchNotesTitle')}</h2>
          <button className="icon-btn" onClick={onClose} aria-label={t('actions.close')}>
            <XIcon size={16} weight="bold" />
          </button>
        </div>

        <div className="modal__body patchnotes__body" data-color-mode="dark">
          {error && <div className="patchnotes__empty">{t('mapSidebar.patchNotesFailed')}</div>}
          {!error && releases === null && <div className="patchnotes__empty">{t('admin.loading')}</div>}
          {!error && releases !== null && releases.length === 0 && (
            <div className="patchnotes__empty">{t('mapSidebar.patchNotesEmpty')}</div>
          )}
          {releases?.map((r) => (
            <section key={r.version || r.name} className="patchnotes__release">
              <div className="patchnotes__release-head">
                <a href={r.url} target="_blank" rel="noopener noreferrer" className="patchnotes__version">
                  v{r.version || r.name}
                </a>
                {r.publishedAt && <span className="patchnotes__date">{fmtDate(r.publishedAt)}</span>}
              </div>
              <MDEditor.Markdown
                className="patchnotes__md"
                source={r.body || t('mapSidebar.patchNotesNoNotes')}
                rehypePlugins={[rehypeSanitize]}
              />
            </section>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
