import { useEffect, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { ReactFlowProvider } from '@xyflow/react';
import { useMapStore } from '../../store/mapStore';
import { MapCanvas } from '../map/MapCanvas';
import { SystemPanel } from './SystemPanel';
import { ShareModeProvider } from '../../context/ShareModeContext';
import type { MapSystem, MapConnection, Signature, Structure } from '../../types';

interface SharePayload {
  mapName:           string;
  ownerName:         string;
  expiresAt:         string;
  includeSigs:       boolean;
  includeBridges:    boolean;
  includeNotes:      boolean;
  includeStructures: boolean;
  systems:           Array<MapSystem & { signatures: Signature[]; structures?: Structure[] }>;
  connections:       MapConnection[];
}

interface ExpiredPayload {
  error:     'expired';
  ownerName: string;
  mapName:   string;
  expiredAt: string;
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'expired';   payload: ExpiredPayload }
  | { kind: 'not_found' }
  | { kind: 'valid';     payload: SharePayload };

function formatLocal(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit',
    });
  } catch { return iso; }
}

function formatRemaining(t: TFunction, iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return t('share.expired');
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  if (h > 0) return t('share.expiresInHM', { hours: h, minutes: m });
  return t('share.expiresInM', { minutes: m });
}

export function SharedMapView({ token }: { token: string }) {
  const { t } = useTranslation();
  const [state, setState] = useState<LoadState>({ kind: 'loading' });

  // Hydrate the map store directly from the share payload. The store's
  // public actions all write back to the server, which would fail in share
  // mode — but reading state is fine, and MapCanvas / SystemPanel select
  // from the store the same way they would in normal use.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/share/${encodeURIComponent(token)}`);
        const body = await res.json().catch(() => ({}));
        if (cancelled) return;

        if (res.status === 410) { setState({ kind: 'expired',   payload: body as ExpiredPayload }); return; }
        if (res.status === 404) { setState({ kind: 'not_found' }); return; }
        if (!res.ok)             { setState({ kind: 'not_found' }); return; }

        const payload = body as SharePayload;
        useMapStore.setState({
          map: {
            id:                     'shared',
            name:                   payload.mapName,
            isCorpMap:              false,
            locked:                 true,
            systems:                payload.systems,
            connections:            payload.connections,
            createdAt:              new Date().toISOString(),
            updatedAt:              payload.expiresAt,
            // Carry the link's category flags onto the map so panels
            // (SystemPanel tab filter, StructuresPane, NotesEditor) can
            // decide whether to render or skip per category.
            shareIncludeSigs:       payload.includeSigs,
            shareIncludeBridges:    payload.includeBridges,
            shareIncludeNotes:      payload.includeNotes,
            shareIncludeStructures: payload.includeStructures,
          },
          activeMapId:        'shared',
          selectedSystemId:   null,
          selectedConnectionId: null,
          currentSystemId:    null,
          undoStack:          [],
        });
        setState({ kind: 'valid', payload });
      } catch {
        if (!cancelled) setState({ kind: 'not_found' });
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  if (state.kind === 'loading') {
    return (
      <div className="loading-screen">
        <span className="loading-screen__logo">◈</span>
      </div>
    );
  }

  if (state.kind === 'expired') {
    return (
      <div className="share-error">
        <div className="share-error__card">
          <div className="share-error__title">{t('shareView.expiredTitle')}</div>
          <p className="share-error__body">
            <Trans
              i18nKey="shareView.expiredBody"
              values={{
                map: state.payload.mapName,
                owner: state.payload.ownerName,
                date: formatLocal(state.payload.expiredAt),
              }}
            />
          </p>
          <p className="share-error__hint">
            {t('shareView.expiredHint', { owner: state.payload.ownerName })}
          </p>
        </div>
      </div>
    );
  }

  if (state.kind === 'not_found') {
    return (
      <div className="share-error">
        <div className="share-error__card">
          <div className="share-error__title">{t('shareView.notFoundTitle')}</div>
          <p className="share-error__body">
            {t('shareView.notFoundBody')}
          </p>
        </div>
      </div>
    );
  }

  // Valid: render a stripped layout — no toolbar, no MapSidebar.
  return (
    <ShareModeProvider token={token}>
      <ReactFlowProvider>
        <SharedMapLayout payload={state.payload} />
      </ReactFlowProvider>
    </ShareModeProvider>
  );
}

function SharedMapLayout({ payload }: { payload: SharePayload }) {
  const { t } = useTranslation();
  // Subscribed via the hook so the system panel opens/closes reactively
  // when the viewer clicks a system on the canvas.
  const selectedSystemId = useMapStore((s) => s.selectedSystemId);
  return (
    <div className="layout layout--shared">
      <div className="share-header">
        <span className="share-header__title">{payload.mapName}</span>
        <span className="share-header__sep">·</span>
        <span className="share-header__meta"><Trans i18nKey="shareView.sharedBy" values={{ owner: payload.ownerName }} /></span>
        <span className="share-header__sep">·</span>
        <span className="share-header__meta">{formatRemaining(t, payload.expiresAt)}</span>
        {/* CTA — sits in the top right, recruits the viewer back to the
            landing page. Strips the share hash so the SPA lands on the
            normal app shell instead of bouncing straight back here. */}
        <a className="share-header__cta" href="/">{t('shareView.cta')}</a>
      </div>
      <div className="layout__body">
        <div className="layout__main">
          <MapCanvas />
          {selectedSystemId && <SystemPanel />}
        </div>
      </div>
    </div>
  );
}
