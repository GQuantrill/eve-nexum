// The app's menus: the menu bar (under the title bar on Windows and Linux, at
// the top of the screen on macOS) and the tray icon's menu. Both are built
// from the current settings and rebuilt whenever they change, so a tick in one
// always matches the other. Every item id is handled once, in `handle`.

#[cfg(target_os = "macos")]
use tauri::menu::AboutMetadata;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Manager, Wry};
use tauri_plugin_opener::OpenerExt;

use crate::settings::Settings;
use crate::{eve_logs, open_settings, show_main, tr, update, updater, AppState};

const ZOOM_STEP: f64 = 0.1;
const ZOOM_MIN: f64 = 0.5;
const ZOOM_MAX: f64 = 2.0;

fn pending_update(app: &AppHandle) -> Option<String> {
    app.state::<AppState>().update_version.lock().unwrap().clone()
}

/// Items the Store build leaves out (see lib.rs, STORE).
const STORE_HIDDEN: &[&str] = &["check_updates", "start_at_login"];

/// The menu bar.
pub fn build_bar(app: &AppHandle, s: &Settings) -> tauri::Result<Menu<Wry>> {
    let version = app.package_info().version.to_string();

    let nexum = Submenu::with_items(app, "Nexum", true, &[
        #[cfg(target_os = "macos")]
        &PredefinedMenuItem::about(app, None, Some(AboutMetadata { version: Some(version.clone()), ..Default::default() }))?,
        #[cfg(target_os = "macos")]
        &PredefinedMenuItem::separator(app)?,
        &MenuItem::with_id(app, "settings", tr("settings"), true, Some("CmdOrCtrl+,"))?,
        &MenuItem::with_id(app, "check_updates", tr("checkUpdates"), true, None::<&str>)?,
        &CheckMenuItem::with_id(app, "start_at_login", tr("startAtLogin"), true, s.start_at_login, None::<&str>)?,
        &PredefinedMenuItem::separator(app)?,
        #[cfg(target_os = "macos")]
        &PredefinedMenuItem::hide(app, None)?,
        #[cfg(target_os = "macos")]
        &PredefinedMenuItem::hide_others(app, None)?,
        #[cfg(target_os = "macos")]
        &PredefinedMenuItem::separator(app)?,
        &MenuItem::with_id(app, "quit", tr("quit"), true, Some("CmdOrCtrl+Q"))?,
    ])?;
    if crate::STORE {
        for id in STORE_HIDDEN {
            if let Some(item) = nexum.get(*id) {
                let _ = nexum.remove(&item);
            }
        }
    }
    if let Some(v) = pending_update(app) {
        nexum.insert_items(&[
            &MenuItem::with_id(app, "install_update", tr("installUpdate").replace("{v}", &v), true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
        ], 0)?;
    }

    let view = Submenu::with_items(app, tr("menuView"), true, &[
        &CheckMenuItem::with_id(app, "on_top", tr("onTop"), true, s.always_on_top, Some("CmdOrCtrl+Shift+T"))?,
        &CheckMenuItem::with_id(app, "overlay", tr("overlay"), true, s.overlay, None::<&str>)?,
        &CheckMenuItem::with_id(app, "overlay_lock", tr("overlayLock"), s.overlay, s.overlay_locked, None::<&str>)?,
        &PredefinedMenuItem::separator(app)?,
        &MenuItem::with_id(app, "reload", tr("reload"), true, Some("CmdOrCtrl+R"))?,
        &PredefinedMenuItem::separator(app)?,
        &MenuItem::with_id(app, "zoom_in", tr("zoomIn"), true, Some("CmdOrCtrl+="))?,
        &MenuItem::with_id(app, "zoom_out", tr("zoomOut"), true, Some("CmdOrCtrl+-"))?,
        &MenuItem::with_id(app, "zoom_reset", tr("zoomReset"), true, Some("CmdOrCtrl+0"))?,
        &PredefinedMenuItem::separator(app)?,
        &MenuItem::with_id(app, "fullscreen", tr("fullscreen"), true, Some("F11"))?,
    ])?;

    let tools = Submenu::with_items(app, tr("menuTools"), true, &[
        &CheckMenuItem::with_id(app, "logs", tr("logs"), true, s.read_logs, None::<&str>)?,
        &CheckMenuItem::with_id(app, "clipboard", tr("clip"), true, s.watch_clipboard, None::<&str>)?,
        &CheckMenuItem::with_id(app, "combat", tr("combatAlerts"), true, s.combat_alerts, None::<&str>)?,
        &PredefinedMenuItem::separator(app)?,
        &MenuItem::with_id(app, "intel", tr("intelChannelsMenu"), true, None::<&str>)?,
        &MenuItem::with_id(app, "log_folder", tr("openLogFolder"), true, None::<&str>)?,
    ])?;

    let help = Submenu::with_items(app, tr("menuHelp"), true, &[
        &MenuItem::with_id(app, "website", tr("website"), true, None::<&str>)?,
        &PredefinedMenuItem::separator(app)?,
        &MenuItem::with_id(app, "version", tr("aboutVersion").replace("{v}", &version), false, None::<&str>)?,
    ])?;

    // macOS has no copy/paste shortcuts in a window without an Edit menu.
    // No Undo/Redo items: Cmd+Z must reach the map's own undo.
    #[cfg(target_os = "macos")]
    {
        let edit = Submenu::with_items(app, tr("menuEdit"), true, &[
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ])?;
        let window = Submenu::with_items(app, tr("menuWindow"), true, &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ])?;
        return Menu::with_items(app, &[&nexum, &edit, &view, &tools, &window, &help]);
    }
    #[cfg(not(target_os = "macos"))]
    Menu::with_items(app, &[&nexum, &view, &tools, &help])
}

/// The tray icon's menu: the everyday toggles, a way back to the window.
pub fn build_tray(app: &AppHandle, s: &Settings) -> tauri::Result<Menu<Wry>> {
    let menu = Menu::with_items(app, &[
        &MenuItem::with_id(app, "show", tr("show"), true, None::<&str>)?,
        &PredefinedMenuItem::separator(app)?,
        &CheckMenuItem::with_id(app, "on_top", tr("onTop"), true, s.always_on_top, None::<&str>)?,
        &CheckMenuItem::with_id(app, "overlay", tr("overlay"), true, s.overlay, None::<&str>)?,
        &CheckMenuItem::with_id(app, "overlay_lock", tr("overlayLock"), s.overlay, s.overlay_locked, None::<&str>)?,
        &CheckMenuItem::with_id(app, "logs", tr("logs"), true, s.read_logs, None::<&str>)?,
        &CheckMenuItem::with_id(app, "clipboard", tr("clip"), true, s.watch_clipboard, None::<&str>)?,
        &CheckMenuItem::with_id(app, "combat", tr("combatAlerts"), true, s.combat_alerts, None::<&str>)?,
        &CheckMenuItem::with_id(app, "start_at_login", tr("startAtLogin"), true, s.start_at_login, None::<&str>)?,
        &PredefinedMenuItem::separator(app)?,
        &MenuItem::with_id(app, "settings", tr("settings"), true, None::<&str>)?,
        &MenuItem::with_id(app, "reload", tr("reload"), true, None::<&str>)?,
        &MenuItem::with_id(app, "check_updates", tr("checkUpdates"), true, None::<&str>)?,
        &PredefinedMenuItem::separator(app)?,
        &MenuItem::with_id(app, "quit", tr("quit"), true, None::<&str>)?,
    ])?;
    if crate::STORE {
        for id in STORE_HIDDEN {
            if let Some(item) = menu.get(*id) {
                let _ = menu.remove(&item);
            }
        }
    }
    if let Some(v) = pending_update(app) {
        menu.insert_items(&[
            &MenuItem::with_id(app, "install_update", tr("installUpdate").replace("{v}", &v), true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
        ], 0)?;
    }
    Ok(menu)
}

/// Put the menu bar in place: the app's menu on macOS, the main window's
/// own bar elsewhere (the settings window keeps none).
pub fn install_bar(app: &AppHandle, s: &Settings) {
    let Ok(menu) = build_bar(app, s) else { return };
    #[cfg(target_os = "macos")]
    {
        let _ = app.set_menu(menu);
    }
    #[cfg(not(target_os = "macos"))]
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_menu(menu);
    }
}

fn set_zoom(app: &AppHandle, zoom: impl FnOnce(f64) -> f64) {
    update(app, |s| s.zoom = (zoom(s.zoom) * 10.0).round() / 10.0);
}

/// Every menu item, from the menu bar or the tray.
pub fn handle(app: &AppHandle, id: &str) {
    let main = app.get_webview_window("main");
    match id {
        "show" => show_main(app),
        "settings" | "intel" => open_settings(app),
        "on_top" => update(app, |s| s.always_on_top = !s.always_on_top),
        "logs" => update(app, |s| s.read_logs = !s.read_logs),
        "combat" => update(app, |s| s.combat_alerts = !s.combat_alerts),
        "overlay" => {
            let on = !app.state::<AppState>().settings.lock().unwrap().overlay;
            update(app, |s| s.overlay = on);
            crate::overlay::show(app, on);
        }
        "overlay_lock" => {
            let on = !app.state::<AppState>().settings.lock().unwrap().overlay_locked;
            update(app, |s| s.overlay_locked = on);
            crate::overlay::lock(app, on);
        }
        "clipboard" => update(app, |s| s.watch_clipboard = !s.watch_clipboard),
        "start_at_login" => {
            let on = !app.state::<AppState>().settings.lock().unwrap().start_at_login;
            update(app, |s| s.start_at_login = on);
            crate::set_start_at_login(app, on);
        }
        "reload" => {
            if let Some(w) = main {
                let _ = w.eval("location.reload()");
            }
        }
        "zoom_in" => set_zoom(app, |z| (z + ZOOM_STEP).min(ZOOM_MAX)),
        "zoom_out" => set_zoom(app, |z| (z - ZOOM_STEP).max(ZOOM_MIN)),
        "zoom_reset" => set_zoom(app, |_| 1.0),
        "fullscreen" => {
            if let Some(w) = main {
                let full = w.is_fullscreen().unwrap_or(false);
                let _ = w.set_fullscreen(!full);
            }
        }
        "log_folder" => {
            if let Some(dir) = eve_logs::log_dir(app) {
                let _ = app.opener().open_path(dir.to_string_lossy(), None::<&str>);
            }
        }
        "website" => {
            let server = app.state::<AppState>().settings.lock().unwrap().server_url.clone();
            let _ = app.opener().open_url(server, None::<&str>);
        }
        "check_updates" => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move { updater::check(&app, true).await });
        }
        "install_update" => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move { updater::install(&app).await });
        }
        "quit" => app.exit(0),
        _ => {}
    }
}
