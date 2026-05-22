import { useEffect, useState } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { api } from '../../api/client';
import { useMapStore } from '../../store/mapStore';
import { MapCanvas } from '../map/MapCanvas';
import { SystemPanel } from './SystemPanel';
import { ShareModeProvider } from '../../context/ShareModeContext';
import type { MapSystem, MapConnection, Signature } from '../../types';

interface SharePayload {
  mapName:     string;
  ownerName:   string;
  expiresAt:   string;
  systems:     Array<MapSystem & { signatures: Signature[] }>;
  connections: MapConnection[];
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

function formatRemaining(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return 'expired';
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  if (h > 0) return `${h}h ${m}m left`;
  return `${m}m left`;
}

export function SharedMapView({ token }: { token: string }) {
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
            id:          'shared',
            name:        payload.mapName,
            isCorpMap:   false,
            locked:      true,
            systems:     payload.systems,
            connections: payload.connections,
            createdAt:   new Date().toISOString(),
            updatedAt:   payload.expiresAt,
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
          <div className="share-error__title">Share link expired</div>
          <p className="share-error__body">
            This shared view of <strong>{state.payload.mapName}</strong> was
            published by <strong>{state.payload.ownerName}</strong> and expired
            on <strong>{formatLocal(state.payload.expiredAt)}</strong>.
          </p>
          <p className="share-error__hint">
            Ask {state.payload.ownerName} for a fresh link.
          </p>
        </div>
      </div>
    );
  }

  if (state.kind === 'not_found') {
    return (
      <div className="share-error">
        <div className="share-error__card">
          <div className="share-error__title">Share link not found</div>
          <p className="share-error__body">
            This link doesn't match a known shared map. It may have been
            revoked, or the URL may be incorrect.
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
  // Subscribed via the hook so the system panel opens/closes reactively
  // when the viewer clicks a system on the canvas.
  const selectedSystemId = useMapStore((s) => s.selectedSystemId);
  return (
    <div className="layout layout--shared">
      <div className="share-header">
        <span className="share-header__title">{payload.mapName}</span>
        <span className="share-header__sep">·</span>
        <span className="share-header__meta">shared by <strong>{payload.ownerName}</strong></span>
        <span className="share-header__sep">·</span>
        <span className="share-header__meta">{formatRemaining(payload.expiresAt)}</span>
        {/* CTA — sits in the top right, recruits the viewer back to the
            landing page. Strips the share hash so the SPA lands on the
            normal app shell instead of bouncing straight back here. */}
        <a className="share-header__cta" href="/">Create maps with Nexum today!</a>
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
