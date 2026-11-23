// Auto-update. The app checks the update feed (tauri.conf.json, plugins.updater)
// at startup and every six hours. When a newer version is there it says so once
// (a notification) and offers "Install update" in the tray menu; installing
// downloads it, checks its signature against the public key built into the app,
// and restarts. An update not signed with our key is refused.
//
// Every install, whatever server it points at, updates from the one official
// feed: the app is the same for everyone, only the server differs.

use std::time::Duration;
use tauri::{AppHandle, Manager};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_updater::UpdaterExt;

use crate::{tr, AppState};

const CHECK_EVERY: Duration = Duration::from_secs(6 * 3600);

pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        // Give the window a moment first; an update check is never urgent.
        tokio::time::sleep(Duration::from_secs(20)).await;
        loop {
            check(&app, false).await;
            tokio::time::sleep(CHECK_EVERY).await;
        }
    });
}

/// Look for an update. `asked` = the pilot chose "Check for updates", so say
/// something either way; the background check only speaks about a new version,
/// and only once per version.
pub async fn check(app: &AppHandle, asked: bool) {
    let found = match app.updater() {
        Ok(u) => u.check().await,
        Err(e) => Err(e),
    };
    match found {
        Ok(Some(update)) => {
            let version = update.version.clone();
            let is_new = {
                let state = app.state::<AppState>();
                let mut pending = state.update_version.lock().unwrap();
                let new = pending.as_deref() != Some(version.as_str());
                *pending = Some(version.clone());
                new
            };
            crate::refresh_menu(app);
            if is_new || asked {
                notify(app, &tr("updateReady"), &tr("updateReadyBody").replace("{v}", &version));
            }
        }
        Ok(None) => {
            if asked {
                notify(app, &tr("upToDate"), &format!("v{}", app.package_info().version));
            }
        }
        Err(e) => {
            eprintln!("update check failed: {e}");
            if asked {
                notify(app, &tr("updateFailed"), &reason(&e));
            }
        }
    }
}

/// Download, verify and install the waiting update, then restart.
pub async fn install(app: &AppHandle) {
    let result = async {
        let update = app.updater()?.check().await?.ok_or(tauri_plugin_updater::Error::ReleaseNotFound)?;
        update.download_and_install(|_, _| {}, || {}).await
    }
    .await;
    match result {
        Ok(()) => app.restart(),
        Err(e) => {
            eprintln!("update install failed: {e}");
            notify(app, &tr("updateFailed"), &reason(&e));
        }
    }
}

/// Why it failed, for the notification: the updater's own words (English,
/// technical), so a pilot reporting it can say what went wrong. Kept short.
fn reason(e: &tauri_plugin_updater::Error) -> String {
    e.to_string().chars().take(160).collect()
}

fn notify(app: &AppHandle, title: &str, body: &str) {
    let _ = app.notification().builder().title(title).body(body).show();
}
