import { useUserSetting } from "../../hooks/useUserSetting";
import { useAnnouncer, VOICES } from "../../audio/announcer";
import { ANN } from "../../hooks/useAnnouncerEvents";
import { Select } from "./Select";

// Body of the "Announcer" sidebar section (English-only — this lives on the
// audio demo branch; i18n is added when the announcer graduates from the demo).
// Master enable + voice picker/preview + the five per-event toggles. Everything
// defaults ON: the announcer is on by default and the user opts out. The model
// itself downloads lazily on the first spoken event (or Preview), never eagerly.

function EventToggle({ settingKey, label }: { settingKey: string; label: string }) {
  const [on, setOn] = useUserSetting<boolean>(settingKey, true);
  return (
    <label className="map-sidebar__row map-sidebar__toggle-row">
      <span className="map-sidebar__label">{label}</span>
      <input
        type="checkbox"
        className="map-sidebar__toggle-input"
        checked={on}
        onChange={(e) => setOn(e.target.checked)}
      />
    </label>
  );
}

export function AnnouncerSection() {
  const [enabled, setEnabled] = useUserSetting<boolean>(ANN.enabled, true);
  const [voice, setVoice] = useUserSetting<string>(ANN.voice, "af_nicole");
  const { status, progress, error, speaking, setVoice: setAnnVoice, speak } = useAnnouncer();

  const loading = status === "loading";

  const preview = () => {
    setAnnVoice(voice);
    void speak("Announcer ready. Hostile three jumps out.");
  };

  return (
    <>
      <div className="map-sidebar__hint">
        Spoken alerts using an on-device voice. English only.
      </div>

      <label className="map-sidebar__row map-sidebar__toggle-row">
        <span className="map-sidebar__label">Enable announcer</span>
        <input
          type="checkbox"
          className="map-sidebar__toggle-input"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
      </label>

      {enabled && (
        <>
          <label className="map-sidebar__row" style={{ gap: 8 }}>
            <span className="map-sidebar__label">Voice</span>
            <Select
              value={voice}
              onChange={setVoice}
              options={VOICES.map((v) => ({ value: v.id, label: v.label }))}
            />
          </label>

          <div className="map-sidebar__row">
            <button
              type="button"
              className="toolbar__toggle"
              disabled={loading || speaking}
              onClick={preview}
            >
              {loading ? `Downloading voice… ${progress}%` : speaking ? "Speaking…" : "Preview voice"}
            </button>
            {status === "ready" && (
              <span className="map-sidebar__status map-sidebar__status--ok">Ready</span>
            )}
          </div>
          {error && (
            <div className="map-sidebar__hint" style={{ color: "var(--cv-conn-expired)" }}>
              Voice model failed to load: {error}
            </div>
          )}

          <div className="map-sidebar__hint" style={{ marginTop: 4 }}>Announce:</div>
          <EventToggle settingKey={ANN.connect} label="Character connect / disconnect" />
          <EventToggle settingKey={ANN.incursions} label="Incursions in range" />
          <EventToggle settingKey={ANN.lawless} label="Lawless systems in range" />
          <EventToggle settingKey={ANN.kills} label="Recent kills in range" />
          <EventToggle settingKey={ANN.newChain} label="New chain added by others" />
          <div className="map-sidebar__hint" style={{ marginTop: 4 }}>
            "In range" uses your Proximity Alerts threshold.
          </div>
        </>
      )}
    </>
  );
}
