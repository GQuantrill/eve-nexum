import { useTranslation } from "react-i18next";
import { useUserSetting } from "../../hooks/useUserSetting";
import { useAnnouncer, VOICES } from "../../audio/announcer";
import { ANN } from "../../hooks/useAnnouncerEvents";
import { Select } from "./Select";

// Body of the "Announcer" sidebar section. Master enable + voice picker/preview
// + the five per-event toggles. Everything defaults ON: the announcer is on by
// default and the user opts out. The model downloads lazily on the first spoken
// event (or Preview), never eagerly. UI chrome is translated; the spoken phrases
// stay English (Kokoro is English-only), as does the voice-picker label (voice
// names + accents are proper nouns).

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
  const { t } = useTranslation();
  const [enabled, setEnabled] = useUserSetting<boolean>(ANN.enabled, true);
  const [voice, setVoice] = useUserSetting<string>(ANN.voice, "af_nicole");
  const { status, progress, error, speaking, setVoice: setAnnVoice, speak } = useAnnouncer();

  const loading = status === "loading";

  const preview = () => {
    setAnnVoice(voice);
    // English on purpose — the model only speaks English.
    void speak("Announcer ready. Hostile three jumps out.");
  };

  return (
    <>
      <div className="map-sidebar__hint">{t("mapSidebar.announcer.hint")}</div>

      <label className="map-sidebar__row map-sidebar__toggle-row">
        <span className="map-sidebar__label">{t("mapSidebar.announcer.enable")}</span>
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
            <span className="map-sidebar__label">{t("mapSidebar.announcer.voice")}</span>
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
              {loading
                ? t("mapSidebar.announcer.downloading", { progress })
                : speaking
                ? t("mapSidebar.announcer.speaking")
                : t("mapSidebar.announcer.preview")}
            </button>
            {status === "ready" && (
              <span className="map-sidebar__status map-sidebar__status--ok">
                {t("mapSidebar.announcer.ready")}
              </span>
            )}
          </div>
          {error && (
            <div className="map-sidebar__hint" style={{ color: "var(--cv-conn-expired)" }}>
              {t("mapSidebar.announcer.loadFailed", { error })}
            </div>
          )}

          <div className="map-sidebar__hint" style={{ marginTop: 4 }}>
            {t("mapSidebar.announcer.announce")}
          </div>
          <EventToggle settingKey={ANN.connect} label={t("mapSidebar.announcer.evConnect")} />
          <EventToggle settingKey={ANN.incursions} label={t("mapSidebar.announcer.evIncursions")} />
          <EventToggle settingKey={ANN.lawless} label={t("mapSidebar.announcer.evLawless")} />
          <EventToggle settingKey={ANN.kills} label={t("mapSidebar.announcer.evKills")} />
          <EventToggle settingKey={ANN.newChain} label={t("mapSidebar.announcer.evNewChain")} />
          <div className="map-sidebar__hint" style={{ marginTop: 4 }}>
            {t("mapSidebar.announcer.threshold")}
          </div>
        </>
      )}
    </>
  );
}
