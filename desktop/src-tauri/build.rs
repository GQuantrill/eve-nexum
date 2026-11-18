fn main() {
    // Declaring the app's commands makes each one a permission
    // ("allow-notify", ...), so a window gets only the commands its
    // capability names: the Nexum site cannot touch the app's settings.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "notify",
            "desktop_info",
            "get_settings",
            "save_settings",
            "default_chatlog_dir",
            "intel_status",
            "preview_intel_sound",
            "overlay_update",
            "overlay_state",
            "open_popout",
            "close_popout",
            "intel_feed",
            "open_settings_window",
            "attention",
        ]),
    ))
    .expect("failed to run tauri-build");
}
