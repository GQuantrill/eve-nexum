// Intel channels. The pilot names the channels to follow ("east.imperium");
// EVE writes each as <channel>_YYYYMMDD_HHMMSS[_<characterId>].txt in the
// chat log folder, a new file per session. For each channel this follows the
// newest file (by the date and time in its name) and sends every new line to
// the Nexum window, which pulses any system on the map that the line names.
// The lines go to that window only. The web app sends their words to the
// Nexum server's system-name lookup (not stored there), never the lines.

use regex::Regex;
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

use crate::eve_logs::{self, FileState};
use crate::AppState;

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IntelLine {
    pub channel: String,
    pub sender: String,
    pub text: String,
    /// When EVE wrote the line, epoch milliseconds.
    pub at: u64,
    /// Whether the pilot wants a sound for intel (desktop settings).
    pub sound: bool,
    /// How long and how strongly the system pulses (desktop settings).
    pub pulse_secs: u32,
    pub pulse: String,
    /// Whether to read it aloud when it's within range, and how (desktop
    /// settings).
    pub speak: bool,
    pub speak_volume: u32,
    pub speak_rate: String,
    pub speak_voice: Option<String>,
    /// Sound and voice only for reports within this many jumps of the pilot;
    /// None = for any system on the map (desktop settings).
    pub alert_range: Option<u32>,
}

/// The pilot's intel options, stamped on every line sent to the window.
#[derive(Clone)]
struct LineOptions {
    sound: bool,
    pulse_secs: u32,
    pulse: String,
    speak: bool,
    speak_volume: u32,
    speak_rate: String,
    speak_voice: Option<String>,
    alert_range: Option<u32>,
}

impl LineOptions {
    fn apply(&self, l: IntelLine) -> IntelLine {
        IntelLine {
            sound: self.sound,
            pulse_secs: self.pulse_secs,
            pulse: self.pulse.clone(),
            speak: self.speak,
            speak_volume: self.speak_volume,
            speak_rate: self.speak_rate.clone(),
            speak_voice: self.speak_voice.clone(),
            alert_range: self.alert_range,
            ..l
        }
    }
}

/// Lines kept for the Nexum window's intel feed.
pub const HISTORY_MAX: usize = 100;
/// How far back into a log to read for the feed when it's first opened.
const LOOKBACK_BYTES: u64 = 32 * 1024;

/// The file being followed for one channel.
struct Followed {
    path: PathBuf,
    state: FileState,
    last_at: Option<u64>,
}

/// What the settings window shows under each channel.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelStatus {
    pub channel: String,
    /// The log file being followed; None when none was found.
    pub file: Option<String>,
    /// When the newest line seen so far was written (epoch ms).
    pub last_line_at: Option<u64>,
}

pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        let mut followed: HashMap<String, Followed> = HashMap::new();
        loop {
            std::thread::sleep(Duration::from_secs(1));
            let (channels, opts) = {
                let state = app.state::<AppState>();
                let s = state.settings.lock().unwrap();
                (s.intel_channels.clone(), LineOptions {
                    sound: s.intel_sound,
                    pulse_secs: s.intel_pulse_secs,
                    pulse: s.intel_pulse.clone(),
                    speak: s.intel_speak,
                    speak_volume: s.intel_speak_volume,
                    speak_rate: s.intel_speak_rate.clone(),
                    speak_voice: s.intel_speak_voice.clone(),
                    alert_range: s.intel_alert_range,
                })
            };
            followed.retain(|k, _| channels.iter().any(|c| c.eq_ignore_ascii_case(k)));
            if let Some(dir) = eve_logs::log_dir(&app) {
                let mut history: Vec<IntelLine> = Vec::new();
                let new = poll(&dir, &channels, &mut followed, &mut history);
                let new: Vec<IntelLine> = new.into_iter()
                    .map(|l| opts.apply(l))
                    .collect();
                if !history.is_empty() || !new.is_empty() {
                    let state = app.state::<AppState>();
                    let mut h = state.intel_history.lock().unwrap();
                    h.extend(history.into_iter().chain(new.iter().cloned()));
                    while h.len() > HISTORY_MAX {
                        h.pop_front();
                    }
                }
                for line in new {
                    let _ = app.emit_to("main", "nexum://intel", line);
                }
            }
            let status = channels.iter().map(|c| {
                let f = followed.get(&c.to_lowercase());
                ChannelStatus {
                    channel: c.clone(),
                    file: f.and_then(|f| f.path.file_name()).map(|n| n.to_string_lossy().into_owned()),
                    last_line_at: f.and_then(|f| f.last_at),
                }
            }).collect();
            *app.state::<AppState>().intel_status.lock().unwrap() = status;
        }
    });
}

/// One pass: new lines in each channel's newest log.
/// `history` receives the last lines already in a log when it's first opened:
/// for the feed only, never alerted.
fn poll(
    dir: &Path,
    channels: &[String],
    followed: &mut HashMap<String, Followed>,
    history: &mut Vec<IntelLine>,
) -> Vec<IntelLine> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else { return out };
    let names: Vec<String> = entries.flatten()
        .filter_map(|e| e.file_name().to_str().map(str::to_string))
        .collect();
    for channel in channels {
        let Some(newest) = newest_log(channel, &names) else {
            followed.remove(&channel.to_lowercase());
            continue;
        };
        let path = dir.join(&newest);
        let key = channel.to_lowercase();
        let Ok(len) = std::fs::metadata(&path).map(|m| m.len()) else { continue };
        match followed.get(&key) {
            // Same file as before: carry on below.
            Some(f) if f.path == path => {}
            // A newer session's file while running: read it from the start.
            Some(_) => {
                followed.insert(key.clone(), Followed { path: path.clone(), state: FileState::default(), last_at: None });
            }
            // First sight (app just started, or channel just added): what's
            // already there is history, so start at the end.
            None => {
                history.extend(tail_lines(channel, &path, len));
                let mut state = FileState::default();
                state.offset = len;
                followed.insert(key.clone(), Followed { path: path.clone(), state, last_at: None });
                continue;
            }
        }
        let f = followed.get_mut(&key).unwrap();
        if len < f.state.offset {
            f.state = FileState::default();
        }
        if len == f.state.offset {
            continue;
        }
        let Some(text) = eve_logs::read_new(&f.path, &mut f.state, len) else { continue };
        let lines = parse_lines(channel, &text);
        if let Some(l) = lines.last() {
            f.last_at = Some(l.at);
        }
        out.extend(lines);
    }
    out
}

/// The chat lines in the last few KB of a log (the first, probably cut-off,
/// line dropped when it starts mid-file).
fn tail_lines(channel: &str, path: &Path, len: u64) -> Vec<IntelLine> {
    let start = len.saturating_sub(LOOKBACK_BYTES) & !1; // whole UTF-16 units
    let mut buf = Vec::new();
    let read = std::fs::File::open(path).and_then(|mut f| {
        f.seek(SeekFrom::Start(start))?;
        f.take(len - start).read_to_end(&mut buf)
    });
    if read.is_err() {
        return Vec::new();
    }
    let units: Vec<u16> = buf.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
    let text = String::from_utf16_lossy(&units).replace('\u{feff}', "");
    let text = if start > 0 { text.split_once('\n').map(|(_, rest)| rest).unwrap_or("") } else { &text };
    parse_lines(channel, text)
}

/// The newest log file for a channel among the folder's file names. Matches
/// the channel name exactly (any case), so "east" never picks up "east.imperium".
fn newest_log(channel: &str, names: &[String]) -> Option<String> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"^(.+)_(\d{8})_(\d{6})(?:_\d+)?\.txt$").unwrap());
    names.iter()
        .filter_map(|n| {
            let c = re.captures(n)?;
            c[1].eq_ignore_ascii_case(channel).then(|| (format!("{}{}", &c[2], &c[3]), n.clone()))
        })
        .max()
        .map(|(_, n)| n)
}

/// Chat lines in a block of log text, with the system's own messages left out.
fn parse_lines(channel: &str, text: &str) -> Vec<IntelLine> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(r"^\[ (\d{4})\.(\d{2})\.(\d{2}) (\d{2}):(\d{2}):(\d{2}) \] (.+?) > (.*)$").unwrap()
    });
    text.lines()
        .filter_map(|line| {
            let c = re.captures(line.trim_end_matches('\r'))?;
            let sender = c[7].trim().to_string();
            if sender == "EVE System" {
                return None;
            }
            let n = |i: usize| c[i].parse::<i64>().unwrap();
            Some(IntelLine {
                channel: channel.to_string(),
                sender,
                text: c[8].trim().to_string(),
                at: eve_logs::epoch_ms(n(1), n(2), n(3), n(4), n(5), n(6)),
                sound: true,
                pulse_secs: 5,
                pulse: "normal".to_string(),
                speak: false,
                speak_volume: 100,
                speak_rate: "normal".to_string(),
                speak_voice: None,
                alert_range: None,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn utf16(s: &str) -> Vec<u8> {
        let mut out = Vec::new();
        for u in s.encode_utf16() {
            out.extend_from_slice(&u.to_le_bytes());
        }
        out
    }

    #[test]
    fn picks_the_newest_log_of_exactly_that_channel() {
        let names: Vec<String> = [
            "east.imperium_20261026_120902_1841929906.txt",
            "east.imperium_20260901_080000_1841929906.txt",
            "east_20261101_000000_1.txt",
            "fareast.imperium_20260825_130606_1841929906.txt",
            "Local_20261026_120902_1841929906.txt",
        ].iter().map(|s| s.to_string()).collect();
        assert_eq!(newest_log("east.imperium", &names).as_deref(), Some("east.imperium_20261026_120902_1841929906.txt"));
        assert_eq!(newest_log("EAST.IMPERIUM", &names).as_deref(), Some("east.imperium_20261026_120902_1841929906.txt"));
        assert_eq!(newest_log("fareast.imperium", &names).as_deref(), Some("fareast.imperium_20260825_130606_1841929906.txt"));
        assert_eq!(newest_log("east", &names).as_deref(), Some("east_20261101_000000_1.txt"));
        assert_eq!(newest_log("delve.intel", &names), None);
    }

    #[test]
    fn parses_chat_lines() {
        let text = "[ 2026.10.26 12:10:00 ] EVE System > Channel MOTD: be nice\r\n\
                    [ 2026.10.26 12:10:05 ] Some Pilot > Bad Guy  1DQ1-A\r\n\
                    [ 2026.10.26 12:10:09 ] Other > 1DQ1-A clr\r\n";
        let lines = parse_lines("east.imperium", text);
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].sender, "Some Pilot");
        assert_eq!(lines[0].text, "Bad Guy  1DQ1-A");
        assert_eq!(lines[1].text, "1DQ1-A clr");
    }

    #[test]
    fn follows_new_lines_and_new_sessions() {
        let dir = std::env::temp_dir().join(format!("nexum-intel-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let old = dir.join("east.imperium_20261026_120902_42.txt");
        std::fs::write(&old, utf16("[ 2026.10.26 12:10:00 ] A > old news Jita\r\n")).unwrap();
        let chans = vec!["east.imperium".to_string()];
        let mut followed = HashMap::new();
        let mut history = Vec::new();

        // History already in the file is not reported, only kept for the feed.
        assert!(poll(&dir, &chans, &mut followed, &mut history).is_empty());
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].text, "old news Jita");

        // A new line is.
        use std::io::Write;
        std::fs::OpenOptions::new().append(true).open(&old).unwrap()
            .write_all(&utf16("[ 2026.10.26 12:11:00 ] B > hostile 1DQ1-A\r\n")).unwrap();
        let got = poll(&dir, &chans, &mut followed, &mut history);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].text, "hostile 1DQ1-A");

        // EVE restarts: a newer file appears and is read from its start.
        std::fs::write(dir.join("east.imperium_20261026_140000_42.txt"),
            utf16("[ 2026.10.26 14:00:01 ] C > neut J123456\r\n")).unwrap();
        let got = poll(&dir, &chans, &mut followed, &mut history);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].text, "neut J123456");

        std::fs::remove_dir_all(&dir).ok();
    }
}
