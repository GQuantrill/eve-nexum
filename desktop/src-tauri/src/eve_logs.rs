// Jump tracking from EVE's own Local chat log.
//
// The game writes one log file per Local session (Documents/EVE/logs/Chatlogs/
// Local_YYYYMMDD_HHMMSS_<characterId>.txt, UTF-16) and appends a line the
// moment a pilot changes system:
//
//   [ 2026.05.16 23:56:51 ] EVE System > Channel changed to Local : 25S-6P
//
// That is seconds ahead of ESI. This watcher polls the folder once a second,
// reads only what was appended since last time, and sends the newest system
// change per file to the Nexum window. The web app decides what to do with it
// (and checks the name is a real system); the server never trusts it.

use regex::Regex;
use serde::Serialize;
use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, SystemTime};
use tauri::{AppHandle, Emitter, Manager};

use crate::AppState;

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LocalChange {
    /// EVE character id, from the file name (newer clients write it there).
    pub character_id: Option<u64>,
    /// The "Listener:" in the file header, for older clients without the id.
    pub character_name: Option<String>,
    pub system: String,
    /// When EVE wrote the line, epoch milliseconds (EVE time is UTC).
    pub at: u64,
}

#[derive(Default)]
pub(crate) struct FileState {
    pub(crate) offset: u64,
    carry: Vec<u8>,
    listener: Option<String>,
}

pub fn default_dir() -> Option<PathBuf> {
    dirs::document_dir().map(|d| d.join("EVE").join("logs").join("Chatlogs"))
}

/// The chat log folder in use: the pilot's override, else EVE's usual one.
pub(crate) fn log_dir(app: &AppHandle) -> Option<PathBuf> {
    let state = app.state::<AppState>();
    let dir = state.settings.lock().unwrap().chatlog_dir.clone();
    dir.map(PathBuf::from).or_else(default_dir)
}

pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        let mut files: HashMap<PathBuf, FileState> = HashMap::new();
        loop {
            std::thread::sleep(Duration::from_secs(1));
            let enabled = app.state::<AppState>().settings.lock().unwrap().read_logs;
            let dir = log_dir(&app);
            if !enabled {
                files.clear();
                continue;
            }
            let Some(dir) = dir else { continue };
            for change in scan(&dir, &mut files) {
                let _ = app.emit_to("main", "nexum://local", change);
            }
        }
    });
}

/// One pass over the folder: the newest system change in each Local log that
/// has grown since the last pass.
fn scan(dir: &Path, files: &mut HashMap<PathBuf, FileState>) -> Vec<LocalChange> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else { return out };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else { continue };
        if !name.starts_with("Local_") || !name.ends_with(".txt") {
            continue;
        }
        // Ask the file itself, not the folder listing: on Windows the listing
        // keeps a file's old size while EVE still has it open, so new jumps
        // would go unseen until EVE closed the log.
        let Ok(meta) = std::fs::metadata(&path) else { continue };
        let modified = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        let age = now.duration_since(modified).unwrap_or_default();
        // Only sessions still being written. A file nobody touched for six
        // hours is an old session; forget it.
        if age > Duration::from_secs(6 * 3600) {
            files.remove(&path);
            continue;
        }
        let len = meta.len();
        let first_look = !files.contains_key(&path);
        let st = files.entry(path.clone()).or_default();
        if len < st.offset {
            *st = FileState::default(); // rewritten: start again
        }
        if len == st.offset {
            continue;
        }
        let Some(text) = read_new(&path, st, len) else { continue };
        if st.listener.is_none() {
            st.listener = listener(&text);
        }
        // On first sight only report a session that is live right now; an
        // hour-old file just gets its place remembered.
        if first_look && age > Duration::from_secs(600) {
            continue;
        }
        if let Some((system, at)) = last_change(&text) {
            out.push(LocalChange {
                character_id: character_id(name),
                character_name: st.listener.clone(),
                system,
                at,
            });
        }
    }
    out
}

/// The bytes appended since `st.offset`, decoded from UTF-16LE.
pub(crate) fn read_new(path: &Path, st: &mut FileState, len: u64) -> Option<String> {
    let mut f = File::open(path).ok()?;
    f.seek(SeekFrom::Start(st.offset)).ok()?;
    let mut buf = std::mem::take(&mut st.carry);
    let start = buf.len();
    buf.resize(start + (len - st.offset) as usize, 0);
    f.read_exact(&mut buf[start..]).ok()?;
    st.offset = len;
    // An odd byte is half a character still being written: keep it.
    if buf.len() % 2 == 1 {
        st.carry = vec![buf.pop().unwrap()];
    }
    Some(decode_utf16le(&buf))
}

fn decode_utf16le(bytes: &[u8]) -> String {
    let units: Vec<u16> = bytes.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
    String::from_utf16_lossy(&units).replace('\u{feff}', "")
}

fn character_id(file_name: &str) -> Option<u64> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"^Local_\d{8}_\d{6}_(\d+)\.txt$").unwrap());
    re.captures(file_name)?.get(1)?.as_str().parse().ok()
}

fn listener(text: &str) -> Option<String> {
    text.lines()
        .find_map(|l| l.trim().strip_prefix("Listener:").map(|v| v.trim().to_string()))
        .filter(|v| !v.is_empty())
}

/// The newest "EVE System > ... : <system>" line, with its time. English
/// clients say "Channel changed to Local : X"; other languages word it
/// differently, so any EVE System line ending in ": name" counts, and the web
/// app drops names that aren't real systems.
fn last_change(text: &str) -> Option<(String, u64)> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(r"^\[ (\d{4})\.(\d{2})\.(\d{2}) (\d{2}):(\d{2}):(\d{2}) \] EVE System > .*:\s*(\S[^:]*?)\s*$")
            .unwrap()
    });
    text.lines().rev().find_map(|line| {
        let c = re.captures(line.trim_end_matches('\r'))?;
        let n = |i: usize| c.get(i).unwrap().as_str().parse::<i64>().unwrap();
        let at = epoch_ms(n(1), n(2), n(3), n(4), n(5), n(6));
        Some((c.get(7)?.as_str().to_string(), at))
    })
}

/// UTC civil date and time to epoch milliseconds (no date crate needed).
pub(crate) fn epoch_ms(y: i64, m: i64, d: i64, hh: i64, mm: i64, ss: i64) -> u64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    ((days * 86_400 + hh * 3_600 + mm * 60 + ss) * 1_000) as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn utf16(s: &str) -> Vec<u8> {
        let mut out = vec![0xFF, 0xFE];
        for u in s.encode_utf16() {
            out.extend_from_slice(&u.to_le_bytes());
        }
        out
    }

    const HEADER: &str = "\r\n\r\n  ---------------------------------------------------------------\r\n\r\n    Channel ID:      local\r\n    Channel Name:    Local\r\n    Listener:        addelee\r\n    Session started: 2026.05.16 23:56:49\r\n  ---------------------------------------------------------------\r\n\r\n";

    #[test]
    fn parses_a_jump() {
        let text = format!("{HEADER}[ 2026.05.16 23:56:51 ] EVE System > Channel changed to Local : 25S-6P\r\n");
        assert_eq!(listener(&text).as_deref(), Some("addelee"));
        let (sys, at) = last_change(&text).unwrap();
        assert_eq!(sys, "25S-6P");
        assert_eq!(at, 1_778_975_811_000); // 2026-05-16T23:56:51Z
    }

    #[test]
    fn takes_the_newest_change_and_ignores_chat() {
        let text = format!(
            "{HEADER}[ 2026.05.16 23:56:51 ] EVE System > Channel changed to Local : Jita\r\n\
             [ 2026.05.16 23:57:10 ] Some Pilot > o7 : anyone here\r\n\
             [ 2026.05.16 23:58:02 ] EVE System > Channel changed to Local : J123456\r\n"
        );
        assert_eq!(last_change(&text).unwrap().0, "J123456");
    }

    #[test]
    fn character_id_from_file_name() {
        assert_eq!(character_id("Local_20260516_235649_1841929906.txt"), Some(1_841_929_906));
        assert_eq!(character_id("Local_20260516_235649.txt"), None);
    }

    #[test]
    fn watches_a_growing_file() {
        let dir = std::env::temp_dir().join(format!("nexum-logs-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("Local_20260516_235649_42.txt");
        std::fs::write(&file, utf16(&format!("{HEADER}[ 2026.05.16 23:56:51 ] EVE System > Channel changed to Local : Jita\r\n"))).unwrap();

        let mut files = HashMap::new();
        let first = scan(&dir, &mut files);
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].system, "Jita");
        assert_eq!(first[0].character_id, Some(42));
        assert_eq!(first[0].character_name.as_deref(), Some("addelee"));

        // Nothing new: nothing sent.
        assert!(scan(&dir, &mut files).is_empty());

        // A jump appended (no BOM mid-file).
        let mut more = Vec::new();
        for u in "[ 2026.05.16 23:59:00 ] EVE System > Channel changed to Local : Perimeter\r\n".encode_utf16() {
            more.extend_from_slice(&u.to_le_bytes());
        }
        use std::io::Write;
        std::fs::OpenOptions::new().append(true).open(&file).unwrap().write_all(&more).unwrap();
        let next = scan(&dir, &mut files);
        assert_eq!(next.len(), 1);
        assert_eq!(next[0].system, "Perimeter");
        assert_eq!(next[0].character_name.as_deref(), Some("addelee"));

        std::fs::remove_dir_all(&dir).ok();
    }
}
