import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { XIcon } from '@phosphor-icons/react';
import { api } from '../../api/client';
import { useMapStore } from '../../store/mapStore';
import { useAuth } from '../../context/AuthContext';
import { toast } from './Toaster';

interface Region {
  id: number;
  name: string;
  systemCount: number;
  positionedCount: number;
}

const MAX_REGION_RESULTS = 8;

// Unified "create map" modal: name, an optional personal/corp selector (only
// for users with corp roles), and an optional region search. Blank region →
// a normal blank map; a selected region seeds the map with that region's
// systems + stargates (POST /api/maps/from-region). Replaces the old dual
// "+ Personal/Corp Map" buttons and the name PromptModal.
export function CreateMapModal({ onClose }: { onClose: () => void }) {
  const maps         = useMapStore((s) => s.maps);
  const maxMaps      = useMapStore((s) => s.maxMaps);
  const maxCorpMaps  = useMapStore((s) => s.maxCorpMaps);
  const corpMapCount = useMapStore((s) => s.corpMapCount);
  const createMap        = useMapStore((s) => s.createMap);
  const createFromRegion = useMapStore((s) => s.createFromRegion);
  const { user } = useAuth();

  const canCorp = !!user?.corpMode && (user?.role === 'full' || user?.role === 'admin');
  const atPersonalLimit = maps.filter((m) => !m.isCorpMap).length >= maxMaps;
  const atCorpLimit     = corpMapCount >= maxCorpMaps;

  const [name, setName]   = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [isCorp, setIsCorp] = useState(false);

  const [regions, setRegions] = useState<Region[]>([]);
  const [query, setQuery]     = useState('');
  const [region, setRegion]   = useState<Region | null>(null);

  const [busy, setBusy]   = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load the region list once (K-space only, from the server).
  useEffect(() => {
    api<{ regions: Region[] }>('/api/regions')
      .then((r) => setRegions(r.regions))
      .catch(() => { /* picker just stays empty; blank maps still work */ });
  }, []);

  // Type-to-filter results, hidden once a region is chosen.
  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || region) return [];
    return regions.filter((r) => r.name.toLowerCase().includes(q)).slice(0, MAX_REGION_RESULTS);
  }, [query, region, regions]);

  function selectRegion(r: Region) {
    setRegion(r);
    setQuery(r.name);
    // Default the map name to the region unless the user typed their own.
    if (!nameTouched) setName(r.name);
  }

  function clearRegion() {
    setRegion(null);
    setQuery('');
  }

  const limitForChoice = isCorp ? atCorpLimit : atPersonalLimit;
  const canSubmit = !busy && name.trim().length > 0 && !limitForChoice;

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const trimmed = name.trim();
      if (region) {
        await createFromRegion(region.id, trimmed, isCorp);
        toast.success(`Created "${trimmed}" from ${region.name}`);
      } else {
        await createMap(trimmed, isCorp);
      }
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create map');
    } finally {
      setBusy(false);
    }
  }

  return createPortal(
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true">
        <div className="modal__header">
          <h2 className="modal__title">New Map</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <XIcon size={16} weight="bold" />
          </button>
        </div>

        <div className="modal__body">
          <label className="field">
            <span>Map name</span>
            <input
              type="text"
              value={name}
              autoFocus
              placeholder="New Map"
              onChange={(e) => { setName(e.target.value); setNameTouched(true); }}
              maxLength={200}
            />
          </label>

          {canCorp && (
            <label className="field">
              <span>Type</span>
              <select value={isCorp ? 'corp' : 'personal'} onChange={(e) => setIsCorp(e.target.value === 'corp')}>
                <option value="personal">Personal</option>
                <option value="corp">Corp</option>
              </select>
            </label>
          )}

          <div className="field">
            <span>Region (optional — blank for an empty map)</span>
            <div className="search-field">
              <div className="search-field__wrap">
                <input
                  type="text"
                  className={`search-field__input${region ? ' search-field__input--selected' : ''}`}
                  value={query}
                  placeholder="Type to search regions…"
                  autoComplete="off"
                  readOnly={!!region}
                  onChange={(e) => setQuery(e.target.value)}
                />
                {region && (
                  <button type="button" className="search-field__clear" onClick={clearRegion} aria-label="Clear region">
                    ✕
                  </button>
                )}
              </div>
              {results.length > 0 && (
                <ul className="search-results" role="listbox">
                  {results.map((r) => (
                    <li
                      key={r.id}
                      className="search-results__item"
                      role="option"
                      aria-selected={false}
                      onMouseDown={(e) => { e.preventDefault(); selectRegion(r); }}
                    >
                      <span>{r.name}</span>
                      <span className="search-results__class">{r.systemCount} systems</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          {region && (
            <div className="map-sidebar__hint">
              Seeds {region.systemCount} systems from {region.name}, positioned by their
              in-game coordinates with all stargate links.
            </div>
          )}
          {limitForChoice && (
            <div className="map-sidebar__hint map-sidebar__hint--error">
              {isCorp ? `Corp map limit reached (${maxCorpMaps}).` : `Personal map limit reached (${maxMaps}).`}
            </div>
          )}
          {error && <div className="map-sidebar__hint map-sidebar__hint--error">{error}</div>}

          <div className="modal__actions">
            <button type="button" className="btn btn--ghost" onClick={onClose} disabled={busy}>Cancel</button>
            <button type="button" className="btn btn--primary" onClick={submit} disabled={!canSubmit}>
              {busy ? 'Creating…' : 'Create map'}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
