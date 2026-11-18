// Combat alerts from EVE's game logs (opt-in, desktop settings).
//
// Each logged-in client writes a game log (Documents/EVE/logs/Gamelogs/
// YYYYMMDD_HHMMSS_<characterId>.txt, next to Chatlogs) with a "Listener:"
// header naming the character, and a line for every shot, e.g.
//
//   [ 2026.11.18 19:01:02 ] (combat) <color=0xffcc0000><b>45</b> <color=...>
//     <font size=10>from</font> <b><color=...>Pilot Name[CORP](Rifter)</b> ...
//   [ 2026.11.18 19:01:03 ] (combat) <color=...><b>Warp scramble attempt</b>
//     ... from ... Pilot Name ... to ... you!
//
// Two alerts, as a system notification plus a taskbar flash:
// - "Under attack": the first hit from a PLAYER (their name is followed by
//   [TICKER](Ship); NPCs have neither) after a quiet minute, so ratting
//   doesn't alert and a fight alerts once, not every shot.
// - "Warp scrambled" / "Warp disrupted": a scramble or disruption attempt on
//   you, at most once every two minutes per attacker.
//
// The log text never leaves the computer.

use regex::Regex;
use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, Instant, SystemTime};
use tauri::{AppHandle, Manager};
use tauri_plugin_notification::NotificationExt;

use crate::{eve_logs, tr, AppState};

const QUIET: Duration = Duration::from_secs(60);
const SCRAM_REPEAT: Duration = Duration::from_secs(120);

#[derive(Debug, PartialEq)]
pub enum Event {
    /// Damage to you from a player: their name as the log shows it.
    Hit { attacker: String },
    /// A warp scramble (true) or disruption (false) attempt on you.
    Tackle { attacker: String, scram: bool },
}

#[derive(Default)]
struct GameLog {
    offset: u64,
    carry: Vec<u8>,
    utf16: Option<bool>,
    listener: Option<String>,
    last_hit: Option<Instant>,
    tackled: HashMap<String, Instant>,
}

/// The game log folder: Gamelogs, next to the chat log folder.
fn game_log_dir(app: &AppHandle) -> Option<PathBuf> {
    eve_logs::log_dir(app)?.parent().map(|p| p.join("Gamelogs"))
}

pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        let mut files: HashMap<PathBuf, GameLog> = HashMap::new();
        loop {
            std::thread::sleep(Duration::from_secs(1));
            let on = app.state::<AppState>().settings.lock().unwrap().combat_alerts;
            if !on {
                files.clear();
                continue;
            }
            let Some(dir) = game_log_dir(&app) else { continue };
            scan(&app, &dir, &mut files);
        }
    });
}

fn scan(app: &AppHandle, dir: &Path, files: &mut HashMap<PathBuf, GameLog>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("txt") {
            continue;
        }
        let Ok(meta) = std::fs::metadata(&path) else { continue };
        let age = now.duration_since(meta.modified().unwrap_or(SystemTime::UNIX_EPOCH)).unwrap_or_default();
        if age > Duration::from_secs(6 * 3600) {
            files.remove(&path);
            continue;
        }
        let len = meta.len();
        if !files.contains_key(&path) {
            // First sight: name the character from the header, then start at
            // the end. Only what's written from now on can alert.
            let mut log = GameLog::default();
            if let Some(head) = read_range(&path, 0, len.min(2048)) {
                log.utf16 = Some(is_utf16(&head));
                log.listener = listener(&decode(&head, log.utf16 == Some(true)));
            }
            log.offset = len;
            files.insert(path.clone(), log);
            continue;
        }
        let log = files.get_mut(&path).unwrap();
        if len < log.offset {
            *log = GameLog::default();
        }
        if len == log.offset {
            continue;
        }
        let Some(mut bytes) = read_range(&path, log.offset, len) else { continue };
        if log.offset == 0 {
            log.utf16 = Some(is_utf16(&bytes));
        }
        log.offset = len;
        let utf16 = log.utf16 == Some(true);
        let mut buf = std::mem::take(&mut log.carry);
        buf.append(&mut bytes);
        // Keep a line still being written for next time.
        let cut = complete_lines(&buf, utf16);
        log.carry = buf.split_off(cut);
        let text = decode(&buf, utf16);
        if log.listener.is_none() {
            log.listener = listener(&text);
        }
        for line in text.lines() {
            if let Some(ev) = parse(line) {
                alert(app, log, ev);
            }
        }
    }
}

fn alert(app: &AppHandle, log: &mut GameLog, ev: Event) {
    let now = Instant::now();
    let who = log.listener.clone().unwrap_or_else(|| tr("combatYou"));
    let (title, body) = match ev {
        Event::Hit { attacker } => {
            let quiet = log.last_hit.map_or(true, |t| now.duration_since(t) >= QUIET);
            log.last_hit = Some(now);
            if !quiet {
                return;
            }
            (tr("combatHit"), tr("combatHitBody").replace("{attacker}", &attacker).replace("{pilot}", &who))
        }
        Event::Tackle { attacker, scram } => {
            if log.tackled.get(&attacker).is_some_and(|t| now.duration_since(*t) < SCRAM_REPEAT) {
                return;
            }
            log.tackled.insert(attacker.clone(), now);
            let (t, b) = if scram { ("combatScram", "combatScramBody") } else { ("combatPoint", "combatPointBody") };
            (tr(t), tr(b).replace("{attacker}", &attacker).replace("{pilot}", &who))
        }
    };
    let _ = app.notification().builder().title(title).body(body).show();
    if let Some(w) = app.get_webview_window("main") {
        if !w.is_focused().unwrap_or(false) {
            let _ = w.request_user_attention(Some(tauri::UserAttentionType::Critical));
        }
    }
}

fn read_range(path: &Path, from: u64, to: u64) -> Option<Vec<u8>> {
    let mut f = File::open(path).ok()?;
    f.seek(SeekFrom::Start(from)).ok()?;
    let mut buf = vec![0; (to - from) as usize];
    f.read_exact(&mut buf).ok()?;
    Some(buf)
}

/// Game logs are UTF-8 on current clients; read UTF-16 too, as the chat logs
/// are, in case a client writes them that way.
fn is_utf16(head: &[u8]) -> bool {
    head.starts_with(&[0xFF, 0xFE]) || (head.len() > 3 && head[1] == 0 && head[3] == 0)
}

/// How many bytes make up whole lines (up to and including the last newline).
fn complete_lines(buf: &[u8], utf16: bool) -> usize {
    if utf16 {
        let mut i = buf.len() & !1;
        while i >= 2 {
            if buf[i - 2] == b'\n' && buf[i - 1] == 0 {
                return i;
            }
            i -= 2;
        }
        0
    } else {
        buf.iter().rposition(|&b| b == b'\n').map_or(0, |i| i + 1)
    }
}

fn decode(bytes: &[u8], utf16: bool) -> String {
    if utf16 {
        let units: Vec<u16> = bytes.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        String::from_utf16_lossy(&units).replace('\u{feff}', "")
    } else {
        String::from_utf8_lossy(bytes).replace('\u{feff}', "")
    }
}

fn listener(text: &str) -> Option<String> {
    text.lines()
        .find_map(|l| l.trim().strip_prefix("Listener:").map(|v| v.trim().to_string()))
        .filter(|v| !v.is_empty())
}

/// A combat line without its markup: "45 from Pilot[CORP](Rifter) - ...".
fn plain(line: &str) -> Option<String> {
    static TAG: OnceLock<Regex> = OnceLock::new();
    let tag = TAG.get_or_init(|| Regex::new(r"<[^>]*>").unwrap());
    let rest = line.split_once("] (combat) ")?.1;
    Some(tag.replace_all(rest, "").split_whitespace().collect::<Vec<_>>().join(" "))
}

pub fn parse(line: &str) -> Option<Event> {
    static HIT: OnceLock<Regex> = OnceLock::new();
    static TACKLE: OnceLock<Regex> = OnceLock::new();
    let text = plain(line.trim_end_matches('\r'))?;
    // "Warp scramble attempt from X to you!" (and "from you to X" when it's yours).
    let tackle = TACKLE.get_or_init(|| {
        Regex::new(r"(?i)^Warp (scramble|disruption) attempt from (.+?) to you!?$").unwrap()
    });
    if let Some(c) = tackle.captures(&text) {
        let attacker = c[2].trim().to_string();
        if attacker.eq_ignore_ascii_case("you") {
            return None;
        }
        return Some(Event::Tackle { attacker, scram: c[1].eq_ignore_ascii_case("scramble") });
    }
    // "<damage> from <Name[TICKER](Ship)> - <weapon> - <quality>": a player.
    let hit = HIT.get_or_init(|| Regex::new(r"^\d+ from (.+?\[[^\]]+\]\([^)]+\))").unwrap());
    let c = hit.captures(&text)?;
    Some(Event::Hit { attacker: c[1].to_string() })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn player_hits() {
        let l = "[ 2026.11.18 19:01:02 ] (combat) <color=0xffcc0000><b>45</b> <color=0x77ffffff><font size=10>from</font> <b><color=0xffffffff>Some Pilot[ABC](Rifter)</b><font size=10><color=0x77ffffff> - 200mm AutoCannon II - Hits";
        assert_eq!(parse(l), Some(Event::Hit { attacker: "Some Pilot[ABC](Rifter)".into() }));
    }

    #[test]
    fn npc_hits_and_own_shots_dont_alert() {
        let npc = "[ 2026.11.18 19:01:02 ] (combat) <color=0xffcc0000><b>45</b> <color=0x77ffffff><font size=10>from</font> <b><color=0xffffffff>Guristas Enforcer</b><font size=10><color=0x77ffffff> - Light Missile - Hits";
        let mine = "[ 2026.11.18 19:01:02 ] (combat) <color=0xff00ffff><b>120</b> <color=0x77ffffff><font size=10>to</font> <b><color=0xffffffff>Some Pilot[ABC](Rifter)</b><font size=10><color=0x77ffffff> - 200mm AutoCannon II - Hits";
        let notify = "[ 2026.11.18 19:01:02 ] (notify) Your cargo hold is full.";
        assert_eq!(parse(npc), None);
        assert_eq!(parse(mine), None);
        assert_eq!(parse(notify), None);
    }

    #[test]
    fn tackle() {
        let scram = "[ 2026.11.18 19:01:03 ] (combat) <color=0xffffffff><b>Warp scramble attempt</b> <color=0x77ffffff><font size=10>from</font> <color=0xffffffff><b>Some Pilot</b> <color=0x77ffffff><font size=10>to <b><color=0xffffffff></font>you!";
        let point = "[ 2026.11.18 19:01:03 ] (combat) <b>Warp disruption attempt</b> from <b>Some Pilot</b> to <b>you!</b>";
        let mine = "[ 2026.11.18 19:01:03 ] (combat) <b>Warp scramble attempt</b> from <b>you</b> to <b>Some Pilot</b>";
        assert_eq!(parse(scram), Some(Event::Tackle { attacker: "Some Pilot".into(), scram: true }));
        assert_eq!(parse(point), Some(Event::Tackle { attacker: "Some Pilot".into(), scram: false }));
        assert_eq!(parse(mine), None);
    }

    #[test]
    fn whole_lines_only() {
        assert_eq!(complete_lines(b"abc\ndef", false), 4);
        assert_eq!(complete_lines(b"abc", false), 0);
        let u: Vec<u8> = "a\nb".encode_utf16().flat_map(|c| c.to_le_bytes()).collect();
        assert_eq!(complete_lines(&u, true), 4);
    }
}
