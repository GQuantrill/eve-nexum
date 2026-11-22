// Scan paste. Only while the pilot has turned it on (off by default), and
// only for something copied IN EVE: the clipboard is used only when EVE was
// the window in front just before the copy (foreground.rs). A copy made in a
// browser, a chat app or a wallet is never used; on Windows it isn't even
// read. What's used:
// - probe-scanner results (every line a signature id like "ABC-123" and the
//   scanner's six columns), which the window pastes onto the selected system;
// - a directional scan (lines of type id, name, type, distance, tab-separated),
//   which the window opens in its d-scan analyser.
// Anything else is dropped on the spot: nothing is kept (only a fingerprint
// of the last copy where there's no copy counter, to spot the next one),
// logged or sent anywhere. The app
// never changes the clipboard.

use regex::Regex;
use serde::Serialize;
use std::sync::OnceLock;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_clipboard_manager::ClipboardExt;

use crate::{foreground, AppState};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Scan {
    text: String,
    /// The character in the EVE window it was copied in (its title), when
    /// known.
    character: Option<String>,
    /// The pilot wants only scans copied by the character the map tracks.
    /// The Nexum window knows which that is, so it decides.
    tracked_only: bool,
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

/// Probe-scanner results: every non-blank line is a signature id then the
/// scanner's other five columns (group, type, name, signal, distance).
pub fn looks_like_probe_scan(text: &str) -> bool {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"^[A-Z]{3}-\d{3}\t[^\t]*\t[^\t]*\t[^\t]*\t[^\t]*\t[^\t]*$").unwrap());
    let mut lines = text.lines().map(|l| l.trim_end_matches('\r')).filter(|l| !l.trim().is_empty()).peekable();
    lines.peek().is_some() && lines.all(|l| re.is_match(l))
}

/// No scan is anywhere near this big; anything larger isn't looked at.
const MAX_SCAN_BYTES: usize = 256 * 1024;

fn fingerprint(text: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    text.hash(&mut h);
    h.finish()
}

/// What says the clipboard changed: a count of copies (foreground.rs; no
/// reading needed), else a fingerprint of the text (read, then only the
/// fingerprint is kept).
fn marker(app: &AppHandle, copies: &mut foreground::CopyCounter) -> Option<(u64, Option<String>)> {
    if let Some(n) = copies.count() {
        return Some((n, None));
    }
    let text = app.clipboard().read_text().ok()?;
    Some((fingerprint(&text), Some(text)))
}

pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        let mut probe = foreground::Probe::default();
        let mut copies = foreground::CopyCounter::default();
        // EVE in front at the last check; the clipboard's marker then.
        let mut eve_before = false;
        let mut last: Option<u64> = None;
        loop {
            std::thread::sleep(Duration::from_millis(300));
            let (enabled, tracked_only) = {
                let s = app.state::<AppState>();
                let s = s.settings.lock().unwrap();
                (s.watch_clipboard, s.scan_tracked_only)
            };
            if !enabled {
                eve_before = false;
                last = None;
                continue;
            }
            let eve_now = probe.eve_in_front();
            let was = std::mem::replace(&mut eve_before, eve_now);
            if !was {
                if eve_now {
                    // EVE just came to the front: note what's there now (copied
                    // elsewhere), so only a later copy counts. With a copy
                    // counter (Windows, Linux on X11) nothing is read; without
                    // one this is a read whose text is dropped at once.
                    last = marker(&app, &mut copies).map(|(m, _)| m);
                }
                continue;
            }
            // EVE was in front a moment ago, so a copy since then was made in
            // EVE (this check runs even if you've just switched away, so a
            // copy-then-Alt+Tab still counts).
            let Some((m, text)) = marker(&app, &mut copies) else { continue };
            if last == Some(m) {
                continue;
            }
            last = Some(m);
            let Some(text) = text.or_else(|| app.clipboard().read_text().ok()) else { continue };
            if text.len() > MAX_SCAN_BYTES {
                continue;
            }
            let event = if looks_like_probe_scan(&text) {
                "nexum://scan"
            } else if looks_like_dscan(&text) {
                "nexum://dscan"
            } else {
                continue;
            };
            let _ = app.emit_to("main", event, Scan { text, character: probe.character(), tracked_only });
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
        // Every line must be a scanner row, not just one.
        assert!(looks_like_probe_scan("ABC-123\tCosmic Signature\t\t\t0.0%\t12.3 AU\r\nDEF-456\tCosmic Anomaly\tCombat Site\tSansha Hideaway\t100.0%\t2.1 AU\n"));
        assert!(!looks_like_probe_scan("ABC-123\tsomething\nmy seed phrase is ..."));
        assert!(!looks_like_probe_scan("ABC-123\tonly two columns"));
        assert!(!looks_like_probe_scan(""));
    }
}
