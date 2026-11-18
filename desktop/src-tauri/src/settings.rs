// The desktop app's own settings, kept as JSON in the app's config folder.
// Everything a pilot can change lives here; the map itself keeps its settings
// on the Nexum server as it does in a browser.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

pub const DEFAULT_SERVER: &str = "https://eve-nexum.com";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// The Nexum server this app opens. Self-hosters point it at their own.
    pub server_url: String,
    /// Keep the Nexum window above other windows, the EVE client included.
    pub always_on_top: bool,
    /// Move you on the map from EVE's Local chat log, the moment you jump.
    pub read_logs: bool,
    /// Paste probe-scanner results copied in EVE onto the selected system,
    /// and open copied d-scans in the analyser. Off until the pilot turns it
    /// on: it reads the clipboard.
    pub watch_clipboard: bool,
    /// Start Nexum when the pilot logs in to Windows/macOS, hidden in the
    /// tray. Mirrors the system's own setting, which is read at startup.
    pub start_at_login: bool,
    /// Where EVE writes its chat logs, when not the usual Documents folder
    /// (for example a Linux install under Wine or Proton).
    pub chatlog_dir: Option<String>,
    /// Intel channels to follow, by name as in the log files
    /// ("my.intel"); the newest log of each is read.
    pub intel_channels: Vec<String>,
    /// Play a sound when an intel report names a system on the map.
    pub intel_sound: bool,
    /// How long a system named in intel pulses: 5, 10, 15 or 30 seconds.
    pub intel_pulse_secs: u32,
    /// How strongly it pulses: off (sound only), subtle, normal or strong.
    pub intel_pulse: String,
    /// Read intel within the proximity range aloud ("UALX-3, 2 jumps").
    pub intel_speak: bool,
    /// Speech volume, 0-100.
    pub intel_speak_volume: u32,
    /// Speech speed: slow, normal or fast.
    pub intel_speak_rate: String,
    /// The voice to use (its id on this computer); None = the default voice
    /// for the site's language.
    pub intel_speak_voice: Option<String>,
    /// Intel sound and voice only within this many jumps of the pilot;
    /// None = for any system on the map.
    pub intel_alert_range: Option<u32>,
    /// Page zoom of the Nexum window (View > Zoom), 1.0 = 100%.
    pub zoom: f64,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            server_url: DEFAULT_SERVER.to_string(),
            always_on_top: false,
            read_logs: true,
            watch_clipboard: false,
            start_at_login: false,
            chatlog_dir: None,
            intel_channels: Vec::new(),
            intel_sound: true,
            intel_pulse_secs: 5,
            intel_pulse: "normal".to_string(),
            intel_speak: false,
            intel_speak_volume: 100,
            intel_speak_rate: "normal".to_string(),
            intel_speak_voice: None,
            intel_alert_range: None,
            zoom: 1.0,
        }
    }
}

fn path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("settings.json"))
}

pub fn load(app: &AppHandle) -> Settings {
    let loaded = path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<Settings>(&s).ok())
        .unwrap_or_default();
    // A hand-edited file with a bad server falls back rather than opening
    // something that isn't a Nexum server.
    let mut s = match normalise_server(&loaded.server_url) {
        Some(url) => Settings { server_url: url, ..loaded },
        None => Settings { server_url: DEFAULT_SERVER.to_string(), ..loaded },
    };
    normalise_pulse(&mut s);
    s
}

pub fn save(app: &AppHandle, s: &Settings) -> Result<(), String> {
    let p = path(app).ok_or("no config folder")?;
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(s).map_err(|e| e.to_string())?;
    std::fs::write(p, json).map_err(|e| e.to_string())
}

/// A channel as typed, down to the name its log files start with: a pasted
/// file name ("east.imperium_20261026_120902_1841929906.txt") loses its date,
/// time and character parts. Empty when nothing usable is left.
pub fn normalise_channel(raw: &str) -> String {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let re = RE.get_or_init(|| regex::Regex::new(r"(?i)_\d{8}_\d{6}(_\d+)?(\.txt)?$").unwrap());
    let name = raw.trim();
    let name = name.rsplit(['/', '\\']).next().unwrap_or(name);
    re.replace(name, "").trim().to_string()
}

pub const PULSE_SECS: [u32; 4] = [5, 10, 15, 30];
pub const PULSES: [&str; 4] = ["off", "subtle", "normal", "strong"];

/// Intel pulse choices outside the offered ones fall back to the defaults.
pub fn normalise_pulse(s: &mut Settings) {
    if !PULSE_SECS.contains(&s.intel_pulse_secs) {
        s.intel_pulse_secs = 5;
    }
    if !PULSES.contains(&s.intel_pulse.as_str()) {
        s.intel_pulse = "normal".to_string();
    }
    s.intel_speak_volume = s.intel_speak_volume.min(100);
    if !["slow", "normal", "fast"].contains(&s.intel_speak_rate.as_str()) {
        s.intel_speak_rate = "normal".to_string();
    }
    if s.intel_speak_voice.as_deref().is_some_and(|v| v.trim().is_empty() || v.len() > 300) {
        s.intel_speak_voice = None;
    }
    s.intel_alert_range = s.intel_alert_range.map(|n| n.min(MAX_ALERT_RANGE));
}

/// The largest intel alert range offered, in jumps.
pub const MAX_ALERT_RANGE: u32 = 50;

/// The server as a bare origin ("https://host[:port]"), or None when it isn't
/// one we'll open: https anywhere, or plain http only on this machine (for
/// someone running Nexum locally).
pub fn normalise_server(raw: &str) -> Option<String> {
    let u = url::Url::parse(raw.trim()).ok()?;
    let host = u.host_str()?;
    let local = matches!(host, "localhost" | "127.0.0.1" | "[::1]");
    if !(u.scheme() == "https" || (u.scheme() == "http" && local)) {
        return None;
    }
    Some(u.origin().ascii_serialization())
}

#[cfg(test)]
mod tests {
    use super::{normalise_channel, normalise_server};

    #[test]
    fn channels() {
        assert_eq!(normalise_channel("east.imperium"), "east.imperium");
        assert_eq!(normalise_channel(" east.imperium_20261026_120902_1841929906 "), "east.imperium");
        assert_eq!(normalise_channel("fareast.imperium_20260825_130606_1841929906.txt"), "fareast.imperium");
        assert_eq!(normalise_channel("Intel_20260825_130606.txt"), "Intel");
        assert_eq!(normalise_channel("   "), "");
    }

    #[test]
    fn servers() {
        assert_eq!(normalise_server("https://eve-nexum.com/"), Some("https://eve-nexum.com".into()));
        assert_eq!(normalise_server("https://map.example.org/some/path"), Some("https://map.example.org".into()));
        assert_eq!(normalise_server("http://localhost:5174"), Some("http://localhost:5174".into()));
        assert_eq!(normalise_server("http://eve-nexum.com"), None);
        assert_eq!(normalise_server("file:///etc/passwd"), None);
        assert_eq!(normalise_server("not a url"), None);
    }
}
