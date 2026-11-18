# Nexum desktop

The Nexum website in its own window ([Tauri 2](https://tauri.app)), plus what a
browser can't do:

| Feature | What it does |
|---|---|
| Jump tracking from EVE logs | Reads EVE's Local chat log and moves you on the map the moment you jump, seconds before ESI. Your other logged-in characters (alts) move the same way. ESI still confirms each move. On by default. |
| Scan paste | Probe-scanner results you copy in EVE paste themselves onto the selected system; a copied d-scan opens in the d-scan analyser, filled in (nothing is analysed or pinned until you say so). Off by default (it reads the clipboard); only text that looks like a probe scan or d-scan is ever sent to the page. |
| Start at login | Optional: starts with Windows/macOS, hidden in the tray (the system runs it with `--minimised`). Also in the Nexum and tray menus. Off by default; the system's own setting is read at startup. |
| Intel channels | Name the intel channels to follow (e.g. `my.intel`); the newest log of each is read. A line naming a system on your map (its full name, as EVE writes a dragged system) pulses it red (strength and 5-30 s duration in Settings), with a sound (on by default). "clr"/"clear" lines don't alert. A sidebar Intel feed shows all channels, with jumps from you. Intel within the proximity range raises "Threat reported" (optionally read aloud, taskbar flash). Words are sent to the server's system-name lookup only (not stored). |
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
- **Release**: the web side (bridge, lookup endpoint) must be on the live
  site before the app is useful against eve-nexum.com.

## Build

`yarn build` makes an installer for the current OS in
`src-tauri/target/release/bundle/`. Builds are unsigned for now: macOS will
ask to confirm opening it, Windows SmartScreen will warn. Signing and CI
builds come later.

## Updates

The app checks `desktop/latest.json` on main
(`raw.githubusercontent.com/GQuantrill/eve-nexum/main/desktop/latest.json`)
20 s after starting and every 6 hours. A newer version shows a notification
and an "Install update" item at the top of the tray menu; "Check for updates"
asks now. Updates must be signed with the updater key: the public half is in
`tauri.conf.json` (`plugins.updater.pubkey`), the private half never goes in
the repo. Every install updates from this one feed, whatever server it uses.

To release version X.Y.Z:

1. Bump `version` in `src-tauri/tauri.conf.json` (and `Cargo.toml`,
   `package.json`).
2. On each platform, build with the key:
   ```sh
   export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/nexum-desktop.key)"
   export TAURI_SIGNING_PRIVATE_KEY_PASSWORD='...'
   yarn build
   node scripts/latest-json.mjs "What changed"
   ```
3. Create the GitHub release `desktop-vX.Y.Z`, attach the installers and
   the bundle the script names.
4. Commit `latest.json`; installed apps see it once it reaches main.
