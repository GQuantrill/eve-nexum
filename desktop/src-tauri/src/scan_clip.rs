// Scan paste. Only while the pilot has turned it on: the clipboard is checked a
// few times a second, and when it holds a scan copied in EVE it goes to the
// Nexum window:
// - probe-scanner results (lines starting with a signature id like "ABC-123"
//   then a tab), which the window pastes onto the selected system;
// - a directional scan (lines of type id, name, type, distance, tab-separated),
//   which the window opens in its d-scan analyser.
// Nothing else on the clipboard is ever sent anywhere.

use regex::Regex;
use serde::Serialize;
use std::sync::OnceLock;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_clipboard_manager::ClipboardExt;

use crate::AppState;

#[derive(Clone, Serialize)]
struct Scan {
    text: String,
}

/// A d-scan: most non-blank lines are "<type id>\t<name>\t<type>\t<distance>".
/// (The same "mostly" rule the server's parser uses, so a stray line doesn't
/// sink a good scan.)
pub fn looks_like_dscan(text: &str) -> bool {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"^\d{1,10}\t[^\t]*\t[^\t]*\t").unwrap());
    let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    let hits = lines.iter().filter(|l| re.is_match(l)).count();
    hits > 0 && hits * 2 >= lines.len()
}

pub fn looks_like_probe_scan(text: &str) -> bool {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"^[A-Z]{3}-\d{3}\t").unwrap());
    text.lines().any(|l| re.is_match(l))
}

pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        // What was on the clipboard when watching started (or last time): only
        // a change is a new scan, never what was already there.
        let mut last: Option<String> = None;
        loop {
            std::thread::sleep(Duration::from_millis(750));
            let enabled = app.state::<AppState>().settings.lock().unwrap().watch_clipboard;
            if !enabled {
                last = None;
                continue;
            }
            let Ok(text) = app.clipboard().read_text() else { continue };
            match &last {
                None => { last = Some(text); continue; } // just armed: baseline
                Some(prev) if *prev == text => continue,
                _ => {}
            }
            last = Some(text.clone());
            if looks_like_probe_scan(&text) {
                let _ = app.emit_to("main", "nexum://scan", Scan { text });
            } else if looks_like_dscan(&text) {
                let _ = app.emit_to("main", "nexum://dscan", Scan { text });
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{looks_like_dscan, looks_like_probe_scan};

    #[test]
    fn dscans() {
        let scan = "35833\tFortizar\tFortizar\t1,234 km\n670\tCapsule\tCapsule\t-\n";
        assert!(looks_like_dscan(scan));
        assert!(!looks_like_probe_scan(scan));
        assert!(!looks_like_dscan("ABC-123\tCosmic Signature\tWormhole\tUnstable Wormhole\t100.0%\t4.21 AU"));
        assert!(!looks_like_dscan("o7 fly safe\n12 jumps to Jita"));
        assert!(!looks_like_dscan("2026\tbudget"));
    }

    #[test]
    fn probe_scans_only() {
        assert!(looks_like_probe_scan("ABC-123\tCosmic Signature\tWormhole\tUnstable Wormhole\t100.0%\t4.21 AU"));
        assert!(!looks_like_probe_scan("o7 fly safe"));
        assert!(!looks_like_probe_scan("my password is hunter2"));
        assert!(!looks_like_probe_scan("abc-123\tlowercase is not EVE"));
    }
}
