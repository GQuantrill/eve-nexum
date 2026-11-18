// External links used across the app. Single source of truth so the invite
// (top bar, settings sidebar, landing-page CTAs) can't drift out of sync.
export const DISCORD_INVITE_URL = 'https://discord.gg/KG8SMXrhZ4';

// The desktop app. Off until it launches: the landing page then says "coming
// soon" instead of offering downloads. The release workflow
// (.github/workflows/desktop-release.yml) also uploads each installer under a
// fixed name, so these links always fetch the newest version.
export const DESKTOP_AVAILABLE = false;
/** macOS builds are on hold: its button says "coming soon" until this is on
 *  (and the macOS build is back in desktop-release.yml). */
export const DESKTOP_MAC_AVAILABLE = false;
const DESKTOP_LATEST = 'https://github.com/GQuantrill/nexum-desktop/releases/latest';
export const DESKTOP_DOWNLOADS = {
  windows: `${DESKTOP_LATEST}/download/Nexum-Windows-setup.exe`,
  macos: `${DESKTOP_LATEST}/download/Nexum-macOS.dmg`,
  linux: `${DESKTOP_LATEST}/download/Nexum-Linux.AppImage`,
  /** Every file (.deb, .rpm) and the release notes. */
  all: DESKTOP_LATEST,
};
