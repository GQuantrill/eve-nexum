import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { XIcon } from '@phosphor-icons/react';
import { useAnnouncer, VOICES } from '../../audio/announcer';
import { useKillLog } from '../../store/killStore';
import { Select } from './Select';

// PROTOTYPE panel to try the in-browser Kokoro voice announcer: load the model
// (a user gesture, which also unlocks browser autoplay), pick a voice, speak
// arbitrary text, and optionally announce live kills. English-only on purpose —
// i18n gets added if this graduates from a prototype.
export function AudioLabModal({ onClose }: { onClose: () => void }) {
  const { status, progress, error, voice, speaking, backend, setVoice, load, speak, stop } = useAnnouncer();
  const [text, setText] = useState('Hostile entering Jita. Two more in Perimeter.');
  const [announceKills, setAnnounceKills] = useState(false);

  const ready = status === 'ready';
  const loading = status === 'loading';

  // Announce new live kills while the toggle is on. Tracks the newest kill id so
  // only genuinely new ones (after enabling) are spoken — not the backlog.
  const log = useKillLog();
  const lastSpokenId = useRef<number | null>(null);
  useEffect(() => {
    if (!announceKills || !ready) return;
    const newest = log[0];
    if (!newest) return;
    if (lastSpokenId.current === null) { lastSpokenId.current = newest.killmailId; return; }
    if (newest.killmailId === lastSpokenId.current) return;
    lastSpokenId.current = newest.killmailId;
    const who = newest.victimName ?? newest.shipTypeName;
    void speak(`${who} destroyed in ${newest.systemName}`);
  }, [log, announceKills, ready, speak]);

  return createPortal(
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" style={{ maxWidth: 'min(520px, 94vw)' }}>
        <div className="modal__header">
          <h2 className="modal__title">Voice announcer (beta)</h2>
          <button className="icon-btn" onClick={onClose} title="Close"><XIcon size={14} weight="bold" /></button>
        </div>
        <div className="modal__body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <p style={{ color: 'var(--text-subtle)', fontSize: 13, margin: 0 }}>
            In-browser text-to-speech (Kokoro-82M). The first load downloads the model
            (~80–300&nbsp;MB) and runs locally after that — no server, works offline once cached.
            WebGPU where available, otherwise CPU (slower).
          </p>

          {!ready && (
            <button className="btn btn--primary" disabled={loading} onClick={() => void load()}>
              {loading ? `Loading model… ${progress}%` : 'Enable voice (load model)'}
            </button>
          )}
          {error && <div style={{ color: 'var(--cv-conn-expired)', fontSize: 13 }}>Failed to load: {error}</div>}

          {ready && (
            <>
              <p style={{ color: 'var(--text-subtle)', fontSize: 12, margin: 0 }}>Backend: {backend || 'unknown'}</p>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
                <span>Voice</span>
                <Select value={voice} onChange={setVoice}
                  options={VOICES.map((v) => ({ value: v.id, label: v.label }))} />
              </label>

              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
                <span>Text</span>
                <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2}
                  style={{ resize: 'vertical', width: '100%' }} />
              </label>

              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn--primary" disabled={speaking} onClick={() => void speak(text)}>
                  {speaking ? 'Speaking…' : 'Speak'}
                </button>
                <button className="btn btn--ghost" onClick={stop}>Stop</button>
              </div>

              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                <input type="checkbox" className="sig-checkbox" checked={announceKills}
                  onChange={(e) => { setAnnounceKills(e.target.checked); lastSpokenId.current = null; }} />
                Announce live kills on this map (while this panel is open)
              </label>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
