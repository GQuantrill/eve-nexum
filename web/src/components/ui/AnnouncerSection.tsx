import { useTranslation } from "react-i18next";
import { useUserSetting, readUserSetting } from "../../hooks/useUserSetting";
import { useAnnouncer, VOICES, ANNOUNCER_DOWNLOAD_MB } from "../../audio/announcer";
import { ANN, announcerOn } from "../../hooks/useAnnouncerEvents";
import { VOICE_ON_KEY, VOICE_VOLUME_KEY, ALERT_VOLUME_KEY, ALERT_VOLUME_DEFAULT } from "../../utils/notificationPrefs";
import { isDesktop } from "../../desktop/bridge";
import { Select } from "./Select";

// Body of the "Announcer" sidebar section. Master enable + voice picker/preview
// + the five per-event toggles. The master switch defaults OFF (opt-in; see
// AnnouncerOptInModal); the events default ON under it. The model downloads
// lazily on the first spoken event (or Preview), never eagerly, and its size is
// shown before turning it on. UI chrome is translated; the spoken phrases
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
  const [enabledSetting, setEnabled] = useUserSetting<boolean>(ANN.enabled, false);
  // Always on in the desktop app, so no switch there (see announcerOn).
  const desktop = isDesktop();
  const enabled = announcerOn(enabledSetting);
  const [voice, setVoice] = useUserSetting<string>(ANN.voice, "af_nicole");
  const { status, progress, error, speaking, setVoice: setAnnVoice, speak } = useAnnouncer();
  // A mute and a volume of its own, apart from the alert sounds'. The volume
  // starts where the one shared slider was, so splitting them changed nobody.
  const [voiceOn, setVoiceOn] = useUserSetting<boolean>(VOICE_ON_KEY, true);
  const [voiceVolume, setVoiceVolume] = useUserSetting<number>(
    VOICE_VOLUME_KEY, readUserSetting<number>(ALERT_VOLUME_KEY, ALERT_VOLUME_DEFAULT));

  const loading = status === "loading";

  const preview = () => {
    setAnnVoice(voice);
    // English on purpose — the model only speaks English.
    void speak("Announcer ready. Hostile three jumps out.");
  };

  return (
    <>
      <div
        style={{
          display: "inline-block",
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          fontWeight: 700,
          color: "#e0a13c",
          border: "1px solid #e0a13c55",
          borderRadius: 4,
          padding: "1px 6px",
          marginBottom: 6,
        }}
      >
        {t("mapSidebar.announcer.experimental")}
      </div>
      <div className="map-sidebar__hint">{t("mapSidebar.announcer.hint")}</div>
      {!desktop && status !== "ready" && ANNOUNCER_DOWNLOAD_MB !== null && (
        <div className="map-sidebar__hint">
          {t("mapSidebar.announcer.downloadSize", { mb: ANNOUNCER_DOWNLOAD_MB })}
        </div>
      )}

      {desktop ? (
        <div className="map-sidebar__hint">{t("mapSidebar.announcer.desktopAlwaysOn")}</div>
      ) : (
        <label className="map-sidebar__row map-sidebar__toggle-row">
          <span className="map-sidebar__label">{t("mapSidebar.announcer.enable")}</span>
          <input
            type="checkbox"
            className="map-sidebar__toggle-input"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
        </label>
      )}

      {enabled && (
        <>
          <label className="map-sidebar__row map-sidebar__toggle-row">
            <span className="map-sidebar__label">{t("mapSidebar.announcer.voiceOn")}</span>
            <input
              type="checkbox"
              className="map-sidebar__toggle-input"
              checked={voiceOn !== false}
              onChange={(e) => setVoiceOn(e.target.checked)}
            />
          </label>
          <label className="map-sidebar__field">
            <span>{t("mapSidebar.announcer.voiceVolume", { pct: voiceVolume })}</span>
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={voiceVolume}
              disabled={voiceOn === false}
              onChange={(e) => setVoiceVolume(Number(e.target.value))}
              aria-label={t("mapSidebar.announcer.voiceVolume", { pct: voiceVolume })}
            />
          </label>
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

          <div className="map-sidebar__hint">{t("mapSidebar.announcer.delayNote")}</div>

          <div className="map-sidebar__hint" style={{ marginTop: 4 }}>
            {t("mapSidebar.announcer.announce")}
          </div>
          {desktop && <EventToggle settingKey={ANN.intel} label={t("mapSidebar.announcer.evIntel")} />}
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
