// Nexum desktop: the Nexum website in its own window, plus what a browser
// can't do. EVE's Local chat log moves you on the map the moment you jump,
// probe-scanner results copied in EVE paste themselves in (opt-in), system
// notifications, always-on-top, a tray menu and a global show/hide shortcut.
//
// The window loads the configured Nexum server as a normal website, so the web
// app, its login and its data are exactly what a browser gets. Only that
// server's pages may talk to the app, and only through the few commands below.

mod eve_logs;
mod intel;
mod menus;
mod scan_clip;
mod settings;
mod updater;

use settings::Settings;
use std::sync::Mutex;
use tauri::ipc::CapabilityBuilder;
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;

pub struct AppState {
    pub settings: Mutex<Settings>,
    /// A newer version found by the update check, waiting to be installed.
    pub update_version: Mutex<Option<String>>,
    /// Which log each intel channel is following, for the settings window.
    pub intel_status: Mutex<Vec<intel::ChannelStatus>>,
    /// Recent intel lines, for the Nexum window's intel feed.
    pub intel_history: Mutex<std::collections::VecDeque<intel::IntelLine>>,
}

/// Show/hide Nexum from anywhere, the EVE client included.
const TOGGLE_SHORTCUT: &str = "Alt+Shift+N";
/// EVE's login. The only other site the window may navigate to.
const EVE_SSO_HOST: &str = "login.eveonline.com";

// ── Commands the Nexum site may call ──────────────────────────────────────

#[tauri::command]
fn notify(app: AppHandle, title: String, body: String) {
    let _ = app.notification().builder().title(title).body(body).show();
}

/// The intel feed for the Nexum window: the pilot's channels and recent lines.
#[tauri::command]
fn intel_feed(state: tauri::State<AppState>) -> serde_json::Value {
    let channels = state.settings.lock().unwrap().intel_channels.clone();
    let lines: Vec<intel::IntelLine> = state.intel_history.lock().unwrap().iter().cloned().collect();
    serde_json::json!({ "channels": channels, "lines": lines })
}

/// Draw the pilot's eye to Nexum when it's in the background: the taskbar
/// button flashes (Windows) or the Dock icon bounces (macOS). Nothing when
/// the window already has focus.
#[tauri::command]
fn attention(app: AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        if !w.is_focused().unwrap_or(false) {
            let _ = w.request_user_attention(Some(tauri::UserAttentionType::Informational));
        }
    }
}

/// Open the app's settings window (the intel feed's "Intel settings").
#[tauri::command]
fn open_settings_window(app: AppHandle) {
    open_settings(&app);
}

#[tauri::command]
fn desktop_info(app: AppHandle) -> serde_json::Value {
    serde_json::json!({ "version": app.package_info().version.to_string() })
}

// ── Commands for the app's own settings window ────────────────────────────

#[tauri::command]
fn get_settings(state: tauri::State<AppState>) -> Settings {
    state.settings.lock().unwrap().clone()
}

#[tauri::command]
fn intel_status(state: tauri::State<AppState>) -> Vec<intel::ChannelStatus> {
    state.intel_status.lock().unwrap().clone()
}

#[tauri::command]
fn default_chatlog_dir() -> Option<String> {
    eve_logs::default_dir().map(|p| p.to_string_lossy().into_owned())
}

#[tauri::command]
fn save_settings(app: AppHandle, state: tauri::State<AppState>, settings: Settings) -> Result<(), String> {
    let server = settings::normalise_server(&settings.server_url)
        .ok_or("The server must be an https:// address (or http://localhost).")?;
    let mut next = Settings {
        server_url: server,
        chatlog_dir: settings.chatlog_dir.filter(|d| !d.trim().is_empty()),
        intel_channels: {
            let mut seen = std::collections::HashSet::new();
            settings.intel_channels.iter()
                .map(|c| settings::normalise_channel(c))
                .filter(|c| !c.is_empty() && seen.insert(c.to_lowercase()))
                .collect()
        },
        ..settings
    };
    let server_changed = {
        let mut cur = state.settings.lock().unwrap();
        // Not on the settings form: kept as it is.
        next.zoom = cur.zoom;
        settings::normalise_pulse(&mut next);
        let changed = cur.server_url != next.server_url;
        *cur = next.clone();
        changed
    };
    settings::save(&app, &next)?;
    apply(&app, &next);
    // The intel feed lists the channels: tell it they changed.
    let _ = app.emit_to("main", "nexum://intel-channels", next.intel_channels.clone());
    // The site's permissions are tied to the server it was opened for, so a
    // new server means starting again.
    if server_changed {
        app.restart();
    }
    Ok(())
}

/// Apply settings that take effect without a restart.
fn apply(app: &AppHandle, s: &Settings) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_always_on_top(s.always_on_top);
        let _ = w.set_zoom(s.zoom);
    }
    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_menu(menus::build_tray(app, s).ok());
    }
    menus::install_bar(app, s);
}

/// Rebuild the tray menu from the current state (after an update is found).
pub(crate) fn refresh_menu(app: &AppHandle) {
    let s = app.state::<AppState>().settings.lock().unwrap().clone();
    apply(app, &s);
}

pub(crate) fn update(app: &AppHandle, change: impl FnOnce(&mut Settings)) {
    let state = app.state::<AppState>();
    let next = {
        let mut s = state.settings.lock().unwrap();
        change(&mut s);
        s.clone()
    };
    let _ = settings::save(app, &next);
    apply(app, &next);
}

// ── Windows ───────────────────────────────────────────────────────────────

pub(crate) fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn toggle_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let visible = w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(false);
        let focused = w.is_focused().unwrap_or(false);
        if visible && focused {
            let _ = w.hide();
        } else {
            show_main(app);
        }
    }
}

pub(crate) fn open_settings(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("settings") {
        let _ = w.set_focus();
        return;
    }
    let _ = WebviewWindowBuilder::new(app, "settings", WebviewUrl::App("settings.html".into()))
        .title(tr("title"))
        .inner_size(540.0, 880.0)
        .resizable(true)
        .build();
}

/// Where the Nexum window may go: its own server and EVE's login. Anything
/// else (a zKillboard link, Dotlan, the help pages of another site) opens in
/// the pilot's normal browser instead.
fn allowed_in_window(target: &url::Url, server: &url::Url) -> bool {
    match target.scheme() {
        "http" | "https" => {
            target.origin() == server.origin() || target.host_str() == Some(EVE_SSO_HOST)
        }
        // about:blank only. data:/blob: pages could pose as Nexum inside
        // the app's own window.
        "about" => target.as_str() == "about:blank",
        _ => false,
    }
}

/// The tray's words in the system language, from the same strings file as the
/// settings window (ui/i18n.json), falling back to English.
pub(crate) fn tr(key: &str) -> String {
    static STRINGS: std::sync::OnceLock<serde_json::Value> = std::sync::OnceLock::new();
    let all = STRINGS.get_or_init(|| serde_json::from_str(include_str!("../../ui/i18n.json")).unwrap_or_default());
    let lang = sys_locale::get_locale().unwrap_or_default().chars().take(2).collect::<String>().to_lowercase();
    all.get(&lang).and_then(|l| l.get(key))
        .or_else(|| all.get("en").and_then(|l| l.get(key)))
        .and_then(|v| v.as_str())
        .unwrap_or(key)
        .to_string()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Menu bar and tray items both land here (menus.rs).
        .on_menu_event(|app, event| menus::handle(app, event.id().as_ref()))
        // A second launch just brings the first window forward.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        toggle_main(app);
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            notify,
            desktop_info,
            get_settings,
            save_settings,
            default_chatlog_dir,
            intel_status,
            intel_feed,
            open_settings_window,
            attention
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let s = settings::load(&handle);
            app.manage(AppState {
                settings: Mutex::new(s.clone()),
                update_version: Mutex::new(None),
                intel_status: Mutex::new(Vec::new()),
                intel_history: Mutex::new(std::collections::VecDeque::new()),
            });

            let server = url::Url::parse(&s.server_url)?;

            // The Nexum site may listen for the app's events and call its
            // commands, for this server's pages only, in the main window only.
            app.add_capability(
                CapabilityBuilder::new("nexum-site")
                    .remote(format!("{}/*", s.server_url))
                    .window("main")
                    .permission("core:event:allow-listen")
                    .permission("core:event:allow-unlisten")
                    .permission("allow-notify")
                    .permission("allow-desktop-info")
                    .permission("allow-intel-feed")
                    .permission("allow-open-settings-window")
                    .permission("allow-attention"),
            )?;

            let nav_server = server.clone();
            let nav_app = handle.clone();
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(server.clone()))
                .title("Nexum")
                .inner_size(1440.0, 900.0)
                .min_inner_size(900.0, 600.0)
                .always_on_top(s.always_on_top)
                .on_navigation(move |target| {
                    if allowed_in_window(target, &nav_server) {
                        return true;
                    }
                    // Web links go to the system browser. Nothing else (file:,
                    // custom app schemes) is ever handed to the OS.
                    if matches!(target.scheme(), "http" | "https") {
                        let _ = nav_app.opener().open_url(target.as_str(), None::<&str>);
                    }
                    false
                })
                .build()?;
            apply(&handle, &s);

            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().cloned().expect("app icon"))
                .tooltip("Nexum")
                .menu(&menus::build_tray(&handle, &s)?)
                .build(app)?;

            // Taken by another app: carry on without it.
            let _ = handle.global_shortcut().register(TOGGLE_SHORTCUT);

            eve_logs::start(handle.clone());
            scan_clip::start(handle.clone());
            intel::start(handle.clone());
            updater::start(handle);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Nexum");
}

#[cfg(test)]
mod tests {
    use super::allowed_in_window;

    #[test]
    fn navigation() {
        let server = url::Url::parse("https://eve-nexum.com").unwrap();
        let ok = |u: &str| allowed_in_window(&url::Url::parse(u).unwrap(), &server);
        assert!(ok("https://eve-nexum.com/map"));
        assert!(ok("https://login.eveonline.com/v2/oauth/authorize?x=1"));
        assert!(!ok("https://zkillboard.com/kill/1/"));
        assert!(!ok("http://eve-nexum.com/"));
        assert!(!ok("https://eve-nexum.com.evil.example/"));
        assert!(!ok("file:///etc/passwd"));
        assert!(!ok("data:text/html,<h1>Log in to Nexum</h1>"));
        assert!(!ok("blob:https://eve-nexum.com/1234"));
        assert!(ok("about:blank"));
    }
}
