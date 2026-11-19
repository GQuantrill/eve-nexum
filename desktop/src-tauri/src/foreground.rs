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

#[cfg(windows)]
mod imp {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};

    #[derive(Default)]
    pub struct Probe;

    impl Probe {
        pub fn eve_in_front(&mut self) -> bool {
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

    /// Changes whenever anything is copied, without reading what was copied.
    pub fn clipboard_sequence() -> Option<u64> {
        use windows_sys::Win32::System::DataExchange::GetClipboardSequenceNumber;
        Some(unsafe { GetClipboardSequenceNumber() } as u64)
    }
}

#[cfg(target_os = "linux")]
mod imp {
    use x11rb::connection::Connection;
    use x11rb::protocol::xproto::{AtomEnum, ConnectionExt, Window};
    use x11rb::rust_connection::RustConnection;

    #[derive(Default)]
    pub struct Probe {
        conn: Option<(RustConnection, Window, u32)>,
    }

    impl Probe {
        fn connect() -> Option<(RustConnection, Window, u32)> {
            let (conn, screen) = x11rb::connect(None).ok()?;
            let root = conn.setup().roots.get(screen)?.root;
            let active = conn.intern_atom(true, b"_NET_ACTIVE_WINDOW").ok()?.reply().ok()?.atom;
            if active == 0 {
                return None;
            }
            Some((conn, root, active))
        }

        fn query(&self) -> Option<bool> {
            let (conn, root, active) = self.conn.as_ref()?;
            let reply = conn
                .get_property(false, *root, *active, AtomEnum::WINDOW, 0, 1)
                .ok()?
                .reply()
                .ok()?;
            let win = reply.value32()?.next()?;
            if win == 0 {
                return Some(false);
            }
            let class = conn
                .get_property(false, win, AtomEnum::WM_CLASS, AtomEnum::STRING, 0, 256)
                .ok()?
                .reply()
                .ok()?;
            // "instance\0class\0"
            let class = String::from_utf8_lossy(&class.value).to_ascii_lowercase();
            Some(class.split('\0').any(|c| c == "exefile.exe" || c == "steam_app_8500"))
        }

        pub fn eve_in_front(&mut self) -> bool {
            if self.conn.is_none() {
                self.conn = Self::connect();
            }
            match self.query() {
                Some(v) => v,
                None => {
                    // Lost the connection (or never had one): try again next time.
                    self.conn = None;
                    false
                }
            }
        }
    }

    pub fn clipboard_sequence() -> Option<u64> {
        None
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
    }

    pub fn clipboard_sequence() -> Option<u64> {
        None
    }
}

pub use imp::{clipboard_sequence, Probe};

/// EVE's client executable, from a full path.
#[cfg_attr(not(windows), allow(dead_code))]
fn is_eve_exe(path: &str) -> bool {
    path.rsplit(['\\', '/']).next().is_some_and(|f| f.eq_ignore_ascii_case("exefile.exe"))
}

#[cfg(test)]
mod tests {
    #[test]
    fn eve_exe() {
        assert!(super::is_eve_exe(r"C:\EVE\SharedCache\tq\bin64\exefile.exe"));
        assert!(super::is_eve_exe(r"D:\Games\EVE\tq\bin64\ExeFile.exe"));
        assert!(!super::is_eve_exe(r"C:\Program Files\Mozilla Firefox\firefox.exe"));
        assert!(!super::is_eve_exe(r"C:\evil\exefile.exe.bat"));
    }
}
