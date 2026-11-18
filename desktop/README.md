# Nexum desktop

The Nexum website in its own window ([Tauri 2](https://tauri.app)), plus what a
browser can't do:

| Feature | What it does |
|---|---|
| Jump tracking from EVE logs | Reads EVE's Local chat log and moves you on the map the moment you jump, seconds before ESI. Your other logged-in characters (alts) move the same way. ESI still confirms each move. On by default. |
| Scan paste | Probe-scanner results you copy in EVE paste themselves onto the selected system; a copied d-scan opens in the d-scan analyser, filled in (nothing is analysed or pinned until you say so). Off by default (it reads the clipboard); only text that looks like a probe scan or d-scan is ever sent to the page. |
| Start at login | Optional: starts with Windows/macOS, hidden in the tray (the system runs it with `--minimised`). Also in the Nexum and tray menus. Off by default; the system's own setting is read at startup. |
| Intel sounds | Seven sounds to pick from in Settings, with a Preview button. The Nexum page makes them (`web/src/desktop/intelSounds.ts`, ids shared with `settings.rs` INTEL_SOUNDS and checked by a test); Preview asks the main window to play one. |
| Combat alerts | Opt-in (Settings, Tools and tray menus). Reads EVE's game logs (`Gamelogs`, next to `Chatlogs`): a hit from a player (name followed by `[TICKER](Ship)`; NPCs never alert) after a quiet minute, or a warp scramble/disruption attempt on you (once per attacker per 2 min), gives a notification and a taskbar flash. Parser tested on sample lines only, not real logs yet. |
| Intel overlay | View > Intel overlay: a small always-on-top window with the intel near you, nearest first, and your system. The Nexum page sends the list (`overlay_update`). "Lock overlay" makes it click-through. Place and size remembered. Works over EVE in windowed or fixed-window mode, not exclusive fullscreen. |
| Pop-out panes | A sidebar pane's window button opens it in a window of its own (`?popout=<pane>`; in a browser, a popup). That window loads the map but tracks no jumps, raises no alerts and speaks nothing. The sidebar keeps a stub with "Bring back". Intel lines go to pop-outs too. |
| Intel channels | Name the intel channels to follow (e.g. `my.intel`); the newest log of each is read. A line naming a system on your map (its full name, as EVE writes a dragged system) pulses it red (strength and 5-30 s duration in Settings), with a sound (on by default). "clr"/"clear" lines don't alert. A sidebar Intel feed shows all channels, with jumps from you. Intel within the proximity range raises "Threat reported" (notification, taskbar flash). Sound and the optional read-aloud follow the intel range in Settings: anything on the map (default) or within N jumps of you (needs your location). Words are sent to the server's system-name lookup only (not stored). |
| Always on top | Keep Nexum above the EVE client. |
| Tray + global shortcut | `Alt+Shift+N` shows or hides Nexum from anywhere. |
| System notifications | Nexum's alerts arrive as native notifications. |

The window loads a Nexum server as a normal website (default
`https://eve-nexum.com`; self-hosters change it in Settings). So login, data
and every feature are the same as in a browser, and the web app works
unchanged without the desktop app.

## How the two talk

- `web/src/desktop/bridge.ts` detects the app (`window.__TAURI__`). On the
  web every desktop feature is a no-op.
- Only the configured server's pages, in the main window, get IPC, and only
  `notify`, `desktop_info` and event listening. Settings commands are for the
  app's own settings window only. See `src-tauri/src/lib.rs` and `build.rs`.
- The window may only navigate to its own server and `login.eveonline.com`;
  other links open in the system browser.
- Events: `nexum://intel` (intel-channel lines, `web/src/desktop/intel.ts`),
  `nexum://local` (system change from the Local log, handled in
  `useCharacterLocation.ts` for the acting character and
  `useAccountLocations.ts` for alts), `nexum://scan` (probe-scan paste) and
  `nexum://dscan` (d-scan, opens the analyser), both in
  `web/src/desktop/scanPaste.ts`.
- Log readings only change what that window shows. The server never trusts
  them: anything it decides (contributor adds included) still uses ESI.

## Develop

Needs Rust (stable) and Node. On macOS:

```sh
brew install rustup && rustup default stable
cd desktop
yarn install
yarn dev        # opens the app
cargo test --manifest-path src-tauri/Cargo.toml
```

To point it at a local Nexum (`http://localhost:5174`), set the server in
Settings (tray menu). It restarts onto the new server.

Translations for the tray and settings window live in `ui/i18n.json` (all
10 site languages).

## Not done yet

Recorded so we come back to them:

- **Code signing**: macOS (Apple Developer ID + notarisation) and Windows
  (code-signing certificate). Until then installers warn when opened.
- **CI builds**: GitHub Actions matrix (macOS arm64/x64, Windows, Linux)
  producing installers on release.
- **Real-log testing**: the Local-log parser is unit-tested against sample
  lines only. Still to check against real EVE logs: non-English clients'
  wording, several clients running at once, and Linux (Wine/Proton) paths.
- **Distribution**: a download page / link on the site, and patch notes.
- **Linux, untested on a real install**: CI builds an AppImage, .deb and
  .rpm. EVE runs under Proton/Wine there, so the log folder is looked for in
  Steam's compatdata/8500 prefix (every Steam library), ~/.wine and
  ~/Games/* (Lutris), then ~/Documents. Under Wayland the app runs through
  XWayland (GDK_BACKEND=x11) so always-on-top and the global shortcut work;
  NEXUM_WAYLAND=1 keeps native Wayland. GTK overlay scrollbars are turned
  off (they covered the sidebar's switches). Known limits: no tray where the desktop has none (GNOME without an
  extension), and no spoken intel where WebKitGTK has no speech (the
  option is hidden then).

## Build

`yarn build` makes an installer for the current OS in
`src-tauri/target/release/bundle/`. Builds are unsigned for now: macOS will
ask to confirm opening it, Windows SmartScreen will warn. Signing and CI
builds come later.

Windows gets one installer, the setup .exe (NSIS, no .msi). It is branded
with `src-tauri/installer/sidebar.bmp` (164x314, welcome and finish pages)
and `header.bmp` (150x57, the other pages), and asks for its language
(the site's 10). Both images are drawn from `icons/icon.png` in the site's
colours; redraw them at exactly those sizes as 24-bit BMP if the logo changes.

## Updates

Releases live in their own repository, **GQuantrill/nexum-desktop**, so they
never post to the players' Discord or show as a new server version. The app
checks that repository's `latest.json`
(`github.com/GQuantrill/nexum-desktop/releases/latest/download/latest.json`)
20 s after starting and every 6 hours. A newer version shows a notification
and an "Install update" item at the top of the tray menu; "Check for updates"
asks now. Every install updates from this one feed, whatever server it uses.
The Microsoft Store build has no updater: the Store updates it.

Updates must be signed with the updater key. The public half is in
`tauri.conf.json` (`plugins.updater.pubkey`); the private half is the
`TAURI_SIGNING_PRIVATE_KEY` secret in GitHub Actions, with a backup kept
off-line (`~/.tauri/nexum-desktop-updater.key`, no password). Lose it and
installed apps can never be updated again; leak it and anyone could push an
update, so a new key (and a reinstall for everyone) would be needed.

To release version X.Y.Z:

1. Bump `version` in `src-tauri/tauri.conf.json` (and `Cargo.toml`,
   `package.json`) and commit.
2. `git tag desktop-vX.Y.Z && git push origin desktop-vX.Y.Z`
3. `.github/workflows/desktop-release.yml` builds Windows, macOS (universal)
   and Linux, signs the update bundles, uploads everything plus `latest.json`
   to a draft release, and publishes it once every platform is done.

On Linux only the AppImage updates itself; .deb and .rpm installs are updated
by installing the new package.
