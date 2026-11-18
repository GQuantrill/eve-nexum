// Intel channels. The pilot names the channels to follow ("east.imperium");
// EVE writes each as <channel>_YYYYMMDD_HHMMSS[_<characterId>].txt in the
// chat log folder, a new file per session. For each channel this follows the
// newest file (by the date and time in its name) and sends every new line to
// the Nexum window, which pulses any system on the map that the line names.
// The lines go to that window only, never to the server.

use regex::Regex;
use serde::Serialize;
use std::collections::HashMap;
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
}

/// The file being followed for one channel.
struct Followed {
    path: PathBuf,
    state: FileState,
}

pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        let mut followed: HashMap<String, Followed> = HashMap::new();
        loop {
            std::thread::sleep(Duration::from_secs(1));
            let (channels, sound) = {
                let state = app.state::<AppState>();
                let s = state.settings.lock().unwrap();
                (s.intel_channels.clone(), s.intel_sound)
            };
            followed.retain(|k, _| channels.iter().any(|c| c.eq_ignore_ascii_case(k)));
            if channels.is_empty() {
                continue;
            }
            let Some(dir) = eve_logs::log_dir(&app) else { continue };
            for line in poll(&dir, &channels, &mut followed) {
                let _ = app.emit_to("main", "nexum://intel", IntelLine { sound, ..line });
            }
        }
    });
}

/// One pass: new lines in each channel's newest log.
fn poll(dir: &Path, channels: &[String], followed: &mut HashMap<String, Followed>) -> Vec<IntelLine> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else { return out };
    let names: Vec<String> = entries.flatten()
        .filter_map(|e| e.file_name().to_str().map(str::to_string))
        .collect();
    for channel in channels {
        let Some(newest) = newest_log(channel, &names) else { continue };
        let path = dir.join(&newest);
        let key = channel.to_lowercase();
        let Ok(len) = std::fs::metadata(&path).map(|m| m.len()) else { continue };
        match followed.get(&key) {
            // Same file as before: carry on below.
            Some(f) if f.path == path => {}
            // A newer session's file while running: read it from the start.
            Some(_) => {
                followed.insert(key.clone(), Followed { path: path.clone(), state: FileState::default() });
            }
            // First sight (app just started, or channel just added): what's
            // already there is history, so start at the end.
            None => {
                let mut state = FileState::default();
                state.offset = len;
                followed.insert(key.clone(), Followed { path: path.clone(), state });
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
        out.extend(parse_lines(channel, &text));
    }
    out
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

        // History already in the file is not reported.
        assert!(poll(&dir, &chans, &mut followed).is_empty());

        // A new line is.
        use std::io::Write;
        std::fs::OpenOptions::new().append(true).open(&old).unwrap()
            .write_all(&utf16("[ 2026.10.26 12:11:00 ] B > hostile 1DQ1-A\r\n")).unwrap();
        let got = poll(&dir, &chans, &mut followed);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].text, "hostile 1DQ1-A");

        // EVE restarts: a newer file appears and is read from its start.
        std::fs::write(dir.join("east.imperium_20261026_140000_42.txt"),
            utf16("[ 2026.10.26 14:00:01 ] C > neut J123456\r\n")).unwrap();
        let got = poll(&dir, &chans, &mut followed);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].text, "neut J123456");

        std::fs::remove_dir_all(&dir).ok();
    }
}
