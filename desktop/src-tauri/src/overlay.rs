// The overlay: a small window that stays above EVE (in windowed or
// borderless "fixed window" mode; nothing can draw over exclusive
// fullscreen) and shows the intel reports near you, nearest first, with
// where you are.
//
// The Nexum window works out the jumps (it has the map, your location and
// the routes) and hands the list over with overlay_update; this module keeps
// the latest and passes it to the overlay page (ui/overlay.html).
//
// View > Overlay shows or hides it; "Lock overlay" makes it click-through, so
// clicks reach the game underneath. Its place and size are remembered.

use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

use crate::{settings, tr, AppState};

const LABEL: &str = "overlay";
const MAX_REPORTS: usize = 12;

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayReport {
    pub name: String,
    /// None when your location (so the distance) isn't known.
    pub jumps: Option<u32>,
    /// When it was reported, epoch milliseconds.
    pub at: u64,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayData {
    /// The system you're in, when known.
    pub here: Option<String>,
    pub reports: Vec<OverlayReport>,
}

static LATEST: Mutex<Option<OverlayData>> = Mutex::new(None);

fn clip(s: &str) -> String {
    s.chars().take(40).collect()
}

/// From the Nexum window: the reports to show, nearest first.
#[tauri::command]
pub fn overlay_update(app: AppHandle, data: OverlayData) {
    let data = OverlayData {
        here: data.here.as_deref().map(clip),
        reports: data.reports.into_iter().take(MAX_REPORTS)
            .map(|r| OverlayReport { name: clip(&r.name), ..r })
            .collect(),
    };
    *LATEST.lock().unwrap() = Some(data.clone());
    let _ = app.emit_to(LABEL, "nexum://overlay", data);
}

/// For the overlay page when it opens.
#[tauri::command]
pub fn overlay_state() -> OverlayData {
    LATEST.lock().unwrap().clone().unwrap_or_default()
}

/// Show or hide the overlay.
pub fn show(app: &AppHandle, on: bool) {
    let existing = app.get_webview_window(LABEL);
    if !on {
        if let Some(w) = existing {
            let _ = w.destroy();
        }
        return;
    }
    if existing.is_some() {
        return;
    }
    let s = app.state::<AppState>().settings.lock().unwrap().clone();
    let [x, y, w, h] = s.overlay_bounds.unwrap_or([40.0, 120.0, 260.0, 220.0]);
    let built = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("overlay.html".into()))
        .title(tr("overlay"))
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(true)
        .focused(false)
        .min_inner_size(160.0, 80.0)
        .inner_size(w, h)
        .position(x, y)
        .build();
    let Ok(win) = built else { return };
    let _ = win.set_ignore_cursor_events(s.overlay_locked);
    let handle = app.clone();
    win.on_window_event(move |e| {
        if matches!(e, WindowEvent::Moved(_) | WindowEvent::Resized(_)) {
            remember_bounds(&handle);
        }
    });
}

/// Click-through (locked) or movable.
pub fn lock(app: &AppHandle, on: bool) {
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.set_ignore_cursor_events(on);
    }
}

fn remember_bounds(app: &AppHandle) {
    let Some(w) = app.get_webview_window(LABEL) else { return };
    let scale = w.scale_factor().unwrap_or(1.0);
    let (Ok(pos), Ok(size)) = (w.outer_position(), w.inner_size()) else { return };
    let pos: LogicalPosition<f64> = pos.to_logical(scale);
    let size: LogicalSize<f64> = size.to_logical(scale);
    let state = app.state::<AppState>();
    let next = {
        let mut s = state.settings.lock().unwrap();
        s.overlay_bounds = Some([pos.x, pos.y, size.width, size.height]);
        s.clone()
    };
    let _ = settings::save(app, &next);
}
