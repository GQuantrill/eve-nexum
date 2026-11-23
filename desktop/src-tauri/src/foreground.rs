// Is EVE the window in front? The clipboard watcher (scan_clip.rs) only uses
// a copy made while it was, so whatever is copied in a browser, chat app or
// wallet is never used.
//
// Windows: the foreground window's process is exefile.exe (EVE's client).
// Linux: the active X11 window's WM_CLASS is EVE's under Wine/Proton
// (exefile.exe, or Steam's steam_app_8500). EVE under Proton is always an X11
// (XWayland) window, and this app runs through XWayland too (lib.rs
// linux_env). With no X server at all, nothing counts as EVE.
// Anywhere else (macOS is on hold): nothing counts as EVE.
//
// CopyCounter says that something was copied, without reading it: Windows'
// clipboard sequence number, or on Linux a count of X11 clipboard owner
// changes (XFixes). Copying the same scan twice is two copies, so a pilot who
// copies again after cancelling a paste gets it pasted (a fingerprint of the
// text alone saw the second copy as nothing new).

#[cfg(windows)]
mod imp {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};

    #[derive(Default)]
    pub struct Probe {
        character: Option<String>,
    }

    impl Probe {
        /// The character in the EVE window found in front last time.
        pub fn character(&self) -> Option<String> {
            self.character.clone()
        }

        pub fn eve_in_front(&mut self) -> bool {
            let front = self.front();
            if front {
                self.character = unsafe { title(GetForegroundWindow()) }.as_deref().and_then(super::character_from_title);
            }
            front
        }

        fn front(&mut self) -> bool {
            unsafe {
                let hwnd = GetForegroundWindow();
                if hwnd.is_null() {
                    return false;
                }
                let mut pid = 0u32;
                GetWindowThreadProcessId(hwnd, &mut pid);
                if pid == 0 {
                    return false;
                }
                let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
                if process.is_null() {
                    return false;
                }
                let mut buf = [0u16; 1024];
                let mut len = buf.len() as u32;
                let ok = QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, buf.as_mut_ptr(), &mut len);
                CloseHandle(process);
                if ok == 0 {
                    return false;
                }
                let path = String::from_utf16_lossy(&buf[..len as usize]);
                super::is_eve_exe(&path)
            }
        }
    }

    unsafe fn title(hwnd: windows_sys::Win32::Foundation::HWND) -> Option<String> {
        use windows_sys::Win32::UI::WindowsAndMessaging::GetWindowTextW;
        if hwnd.is_null() {
            return None;
        }
        let mut buf = [0u16; 256];
        let n = GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32);
        (n > 0).then(|| String::from_utf16_lossy(&buf[..n as usize]))
    }

    #[derive(Default)]
    pub struct CopyCounter;

    impl CopyCounter {
        /// Changes whenever anything is copied, without reading what was copied.
        pub fn count(&mut self) -> Option<u64> {
            use windows_sys::Win32::System::DataExchange::GetClipboardSequenceNumber;
            Some(unsafe { GetClipboardSequenceNumber() } as u64)
        }
    }
}

#[cfg(target_os = "linux")]
mod imp {
    use x11rb::connection::Connection;
    use x11rb::protocol::xproto::{AtomEnum, ConnectionExt, Window};
    use x11rb::rust_connection::RustConnection;

    struct Conn {
        conn: RustConnection,
        root: Window,
        active: u32,
        net_wm_name: u32,
        utf8: u32,
    }

    #[derive(Default)]
    pub struct Probe {
        conn: Option<Conn>,
        character: Option<String>,
    }

    impl Probe {
        fn connect() -> Option<Conn> {
            let (conn, screen) = x11rb::connect(None).ok()?;
            let root = conn.setup().roots.get(screen)?.root;
            let atom = |name: &[u8], only_if_exists: bool| {
                conn.intern_atom(only_if_exists, name).ok()?.reply().ok().map(|r| r.atom)
            };
            let active = atom(b"_NET_ACTIVE_WINDOW", true)?;
            if active == 0 {
                return None;
            }
            let net_wm_name = atom(b"_NET_WM_NAME", false)?;
            let utf8 = atom(b"UTF8_STRING", false)?;
            Some(Conn { conn, root, active, net_wm_name, utf8 })
        }

        /// Is EVE in front, and if so its window title.
        fn query(&self) -> Option<Option<String>> {
            let c = self.conn.as_ref()?;
            let reply = c
                .conn
                .get_property(false, c.root, c.active, AtomEnum::WINDOW, 0, 1)
                .ok()?
                .reply()
                .ok()?;
            let win = reply.value32()?.next()?;
            if win == 0 {
                return Some(None);
            }
            let class = c
                .conn
                .get_property(false, win, AtomEnum::WM_CLASS, AtomEnum::STRING, 0, 256)
                .ok()?
                .reply()
                .ok()?;
            // "instance\0class\0"
            let class = String::from_utf8_lossy(&class.value).to_ascii_lowercase();
            if !class.split('\0').any(|n| n == "exefile.exe" || n == "steam_app_8500") {
                return Some(None);
            }
            let read = |prop: u32, ty: u32| {
                c.conn
                    .get_property(false, win, prop, ty, 0, 64)
                    .ok()?
                    .reply()
                    .ok()
                    .filter(|r| !r.value.is_empty())
                    .map(|r| String::from_utf8_lossy(&r.value).into_owned())
            };
            let title = read(c.net_wm_name, c.utf8)
                .or_else(|| read(AtomEnum::WM_NAME.into(), AtomEnum::STRING.into()))
                .unwrap_or_default();
            Some(Some(title))
        }

        /// The character in the EVE window found in front last time.
        pub fn character(&self) -> Option<String> {
            self.character.clone()
        }

        pub fn eve_in_front(&mut self) -> bool {
            if self.conn.is_none() {
                self.conn = Self::connect();
            }
            match self.query() {
                Some(Some(title)) => {
                    self.character = super::character_from_title(&title);
                    true
                }
                Some(None) => false,
                None => {
                    // Lost the connection (or never had one): try again next time.
                    self.conn = None;
                    false
                }
            }
        }
    }

    /// Counts CLIPBOARD owner changes. Wine (EVE under Proton or Wine) takes
    /// the X11 clipboard afresh for every copy made in the game, so each copy
    /// is one change, even of the same text.
    #[derive(Default)]
    pub struct CopyCounter {
        conn: Option<RustConnection>,
        changes: u64,
    }

    impl CopyCounter {
        fn connect() -> Option<RustConnection> {
            use x11rb::protocol::xfixes::{ConnectionExt as _, SelectionEventMask};
            let (conn, screen) = x11rb::connect(None).ok()?;
            let root = conn.setup().roots.get(screen)?.root;
            conn.xfixes_query_version(5, 0).ok()?.reply().ok()?;
            let clipboard = conn.intern_atom(false, b"CLIPBOARD").ok()?.reply().ok()?.atom;
            conn.xfixes_select_selection_input(
                root,
                clipboard,
                SelectionEventMask::SET_SELECTION_OWNER
                    | SelectionEventMask::SELECTION_WINDOW_DESTROY
                    | SelectionEventMask::SELECTION_CLIENT_CLOSE,
            )
            .ok()?
            .check()
            .ok()?;
            Some(conn)
        }

        /// None without an X server or XFixes: the caller then compares the
        /// text instead.
        pub fn count(&mut self) -> Option<u64> {
            use x11rb::protocol::Event;
            if self.conn.is_none() {
                self.conn = Self::connect();
                // A new connection may have missed changes: count one, so the
                // clipboard is looked at again.
                self.changes += 1;
            }
            let conn = self.conn.as_ref()?;
            loop {
                match conn.poll_for_event() {
                    Ok(Some(Event::XfixesSelectionNotify(_))) => self.changes += 1,
                    Ok(Some(_)) => {}
                    Ok(None) => break,
                    Err(_) => {
                        self.conn = None;
                        return None;
                    }
                }
            }
            Some(self.changes)
        }
    }
}

#[cfg(not(any(windows, target_os = "linux")))]
mod imp {
    #[derive(Default)]
    pub struct Probe;

    impl Probe {
        pub fn eve_in_front(&mut self) -> bool {
            false
        }

        pub fn character(&self) -> Option<String> {
            None
        }
    }

    #[derive(Default)]
    pub struct CopyCounter;

    impl CopyCounter {
        pub fn count(&mut self) -> Option<u64> {
            None
        }
    }
}

pub use imp::{CopyCounter, Probe};

/// The character logged in to an EVE window, from its title ("EVE - Name").
/// None at the login or character-select screen (just "EVE").
#[cfg_attr(not(any(windows, target_os = "linux")), allow(dead_code))]
fn character_from_title(title: &str) -> Option<String> {
    let name = title.trim().strip_prefix("EVE - ")?.trim();
    (!name.is_empty()).then(|| name.to_string())
}

/// EVE's client executable, from a full path.
#[cfg_attr(not(windows), allow(dead_code))]
fn is_eve_exe(path: &str) -> bool {
    path.rsplit(['\\', '/']).next().is_some_and(|f| f.eq_ignore_ascii_case("exefile.exe"))
}

#[cfg(test)]
mod tests {
    #[test]
    fn titles() {
        use super::character_from_title as c;
        assert_eq!(c("EVE - Some Pilot").as_deref(), Some("Some Pilot"));
        assert_eq!(c("EVE - Ab'cd Ef-gh ").as_deref(), Some("Ab'cd Ef-gh"));
        assert_eq!(c("EVE"), None);
        assert_eq!(c("EVE - "), None);
        assert_eq!(c("Firefox"), None);
    }

    #[test]
    fn eve_exe() {
        assert!(super::is_eve_exe(r"C:\EVE\SharedCache\tq\bin64\exefile.exe"));
        assert!(super::is_eve_exe(r"D:\Games\EVE\tq\bin64\ExeFile.exe"));
        assert!(!super::is_eve_exe(r"C:\Program Files\Mozilla Firefox\firefox.exe"));
        assert!(!super::is_eve_exe(r"C:\evil\exefile.exe.bat"));
    }
}
