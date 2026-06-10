import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { XIcon, CopyIcon, WarningIcon } from '@phosphor-icons/react';
import { api } from '../../api/client';
import { useAuth } from '../../context/AuthContext';
import { europeanDate, timeAgo } from '../../i18n/format';
import { useNow30s } from '../../hooks/useNow30s';
import { toast } from './Toaster';
import { ConfirmModal } from './ConfirmModal';

// One row as returned by GET /api/keys — never includes the secret, only the
// stored prefix + metadata.
interface ApiKey {
  id:                   string;
  name:                 string;
  tokenPrefix:          string;
  scope:                'read' | 'events';
  contextUserId:        number | null;
  contextCharacterName: string | null;
  lastUsedAt:           string | null;
  expiresAt:            string | null;
  createdAt:            string;
}

// Expiry presets offered in the create form (days from now; 0 = never).
const EXPIRY_OPTIONS = [0, 30, 90, 365] as const;

export function ApiKeysModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const characters = user?.characters ?? [];
  const now = useNow30s();

  const [keys, setKeys]       = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);

  // Create form. Default the bound character to the active one (lazy init so we
  // don't fight an effect over it).
  const [name, setName]           = useState('');
  const [charId, setCharId]       = useState<number | null>(
    () => (characters.find((c) => c.active) ?? characters[0])?.characterId ?? null,
  );
  const [scope, setScope]         = useState<'read' | 'events'>('read');
  const [expiryDays, setExpiry]   = useState<number>(0);
  const [creating, setCreating]   = useState(false);
  // The raw secret, surfaced exactly once right after creation.
  const [newKey, setNewKey]       = useState<{ name: string; key: string } | null>(null);
  const [revokeId, setRevokeId]   = useState<string | null>(null);

  const load = useCallback(() =>
    api<{ keys: ApiKey[] }>('/api/keys')
      .then((r) => setKeys(r.keys))
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false)),
  []);

  useEffect(() => { void load(); }, [load]);

  const canCreate = name.trim().length > 0 && charId != null && !creating;

  async function create() {
    if (!canCreate) return;
    setCreating(true);
    setError(null);
    try {
      const expiresAt = expiryDays > 0
        ? new Date(Date.now() + expiryDays * 86_400_000).toISOString()
        : null;
      const created = await api<{ name: string; key: string }>('/api/keys', {
        method: 'POST',
        body:   JSON.stringify({ name: name.trim(), contextCharacterId: charId, scope, expiresAt }),
      });
      // Re-fetch so the new row carries the canonical shape (bound character
      // name, etc.) the POST response doesn't include.
      await load();
      setNewKey({ name: created.name, key: created.key });
      setName('');
      toast.success(t('apiKeys.created', { name: created.name }));
    } catch (e) {
      setError(e instanceof Error ? e.message : t('apiKeys.createFailed'));
    } finally {
      setCreating(false);
    }
  }

  async function revoke(id: string) {
    const target = keys.find((k) => k.id === id);
    setKeys((prev) => prev.filter((k) => k.id !== id));
    setRevokeId(null);
    try {
      await api(`/api/keys/${id}`, { method: 'DELETE' });
      toast.info(t('apiKeys.revoked', { name: target?.name ?? '' }));
    } catch (e) {
      if (target) setKeys((prev) => [target, ...prev]);
      setError(e instanceof Error ? e.message : t('apiKeys.revokeFailed'));
    }
  }

  function copyKey(raw: string) {
    navigator.clipboard.writeText(raw).then(
      () => toast.success(t('apiKeys.keyCopied')),
      () => toast.error(t('apiKeys.copyFailed')),
    );
  }

  return createPortal(
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true">
        <div className="modal__header">
          <h2 className="modal__title">{t('apiKeys.title')}</h2>
          <button className="icon-btn" onClick={onClose} aria-label={t('actions.close')}>
            <XIcon size={16} weight="bold" />
          </button>
        </div>

        <div className="modal__body">
          <div className="map-sidebar__hint">{t('apiKeys.hint')}</div>

          {/* Show-once secret. Stays until the user closes it. */}
          {newKey && (
            <div className="api-keys__reveal">
              <div className="api-keys__reveal-warn">
                <WarningIcon size={14} weight="fill" />
                {t('apiKeys.copyNow')}
              </div>
              <code className="api-keys__secret">{newKey.key}</code>
              <div className="api-keys__reveal-actions">
                <button type="button" className="btn btn--primary" onClick={() => copyKey(newKey.key)}>
                  <CopyIcon size={14} weight="regular" /> {t('actions.copy')}
                </button>
                <button type="button" className="btn btn--ghost" onClick={() => setNewKey(null)}>
                  {t('apiKeys.dismiss')}
                </button>
              </div>
            </div>
          )}

          {/* Create form */}
          <div className="api-keys__create">
            <label className="field">
              <span>{t('apiKeys.name')}</span>
              <input
                type="text"
                value={name}
                placeholder={t('apiKeys.namePlaceholder')}
                onChange={(e) => setName(e.target.value)}
                maxLength={60}
              />
            </label>
            <label className="field">
              <span>{t('apiKeys.character')}</span>
              <select value={charId ?? ''} onChange={(e) => setCharId(Number(e.target.value))}>
                {characters.map((c) => (
                  <option key={c.characterId} value={c.characterId}>{c.characterName}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>{t('apiKeys.scope')}</span>
              <select value={scope} onChange={(e) => setScope(e.target.value as 'read' | 'events')}>
                <option value="read">{t('apiKeys.scopeRead')}</option>
                <option value="events">{t('apiKeys.scopeEvents')}</option>
              </select>
            </label>
            <label className="field">
              <span>{t('apiKeys.expiry')}</span>
              <select value={expiryDays} onChange={(e) => setExpiry(Number(e.target.value))}>
                {EXPIRY_OPTIONS.map((d) => (
                  <option key={d} value={d}>
                    {d === 0 ? t('apiKeys.expiryNever') : t('apiKeys.expiryDays', { count: d })}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" className="btn btn--primary" onClick={create} disabled={!canCreate}>
              {creating ? t('apiKeys.creating') : t('apiKeys.create')}
            </button>
          </div>

          {error && <div className="map-sidebar__hint map-sidebar__hint--error">{error}</div>}

          {/* Existing keys */}
          <div className="api-keys__list">
            {loading
              ? <div className="map-sidebar__hint">{t('apiKeys.loading')}</div>
              : keys.length === 0
                ? <div className="map-sidebar__hint">{t('apiKeys.none')}</div>
                : keys.map((k) => {
                    const expired = !!k.expiresAt && new Date(k.expiresAt).getTime() <= now;
                    const inert = k.contextUserId == null;
                    return (
                      <div key={k.id} className="api-keys__row">
                        <div className="api-keys__main">
                          <span className="api-keys__name">{k.name}</span>
                          <code className="api-keys__prefix">{k.tokenPrefix}…</code>
                          <span className={`api-keys__scope api-keys__scope--${k.scope}`}>
                            {k.scope === 'events' ? t('apiKeys.scopeEventsBadge') : t('apiKeys.scopeReadBadge')}
                          </span>
                          {(expired || inert) && (
                            <span className="api-keys__flag">
                              {expired ? t('apiKeys.flagExpired') : t('apiKeys.flagInert')}
                            </span>
                          )}
                        </div>
                        <div className="api-keys__meta">
                          <span>{t('apiKeys.boundTo', { name: k.contextCharacterName ?? '—' })}</span>
                          <span>{k.lastUsedAt
                            ? t('apiKeys.lastUsed', { ago: timeAgo(t, new Date(k.lastUsedAt)) })
                            : t('apiKeys.neverUsed')}</span>
                          <span>{k.expiresAt
                            ? t('apiKeys.expires', { date: europeanDate(new Date(k.expiresAt)) })
                            : t('apiKeys.noExpiry')}</span>
                        </div>
                        <button
                          type="button"
                          className="map-shares__revoke api-keys__revoke"
                          onClick={() => setRevokeId(k.id)}
                          title={t('apiKeys.revoke')}
                        >
                          <XIcon size={12} weight="bold" />
                        </button>
                      </div>
                    );
                  })}
          </div>
        </div>
      </div>

      {revokeId && (
        <ConfirmModal
          message={t('apiKeys.revokeConfirm', { name: keys.find((k) => k.id === revokeId)?.name ?? '' })}
          confirmLabel={t('apiKeys.revoke')}
          showDontAskAgain={false}
          onConfirm={() => revoke(revokeId)}
          onCancel={() => setRevokeId(null)}
        />
      )}
    </div>,
    document.body,
  );
}
