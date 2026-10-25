//! Client <-> daemon transport. Unix: a unix socket in a private directory, authenticated by the
//! peer's uid. Windows: TCP on 127.0.0.1 plus a random token kept in a file only the user can read.
use std::path::PathBuf;

/// Where the daemon advertises itself on Windows ({"port":..,"token":..}).
#[cfg(windows)]
fn endpoint_file() -> PathBuf {
    crate::proto::state_dir().join("daemon.json")
}

#[cfg(unix)]
pub use unix_impl::*;
#[cfg(windows)]
pub use windows_impl::*;

#[cfg(unix)]
mod unix_impl {
    use super::PathBuf;
    use std::os::unix::net::UnixStream;
    use std::os::unix::process::CommandExt;

    pub type ClientStream = UnixStream;
    pub type ServerStream = tokio::net::UnixStream;

    pub fn sock_path() -> PathBuf {
        if let Ok(p) = std::env::var("FB_SOCK") {
            return p.into();
        }
        // the lock lives in the state dir: an explicit FB_STATE gets its own socket too
        if std::env::var("FB_STATE").is_ok() {
            return crate::proto::state_dir().join("fb.sock");
        }
        match std::env::var("XDG_RUNTIME_DIR") {
            Ok(d) if !d.is_empty() => PathBuf::from(d).join("fb.sock"),
            _ => crate::proto::state_dir().join("fb.sock"),
        }
    }

    /// Token the client must present (none on unix: the kernel tells us who the peer is).
    pub fn client_token() -> Option<String> {
        None
    }

    /// Never talk to a socket another user created: requests can carry secrets (e.g. a PIN).
    fn mine(p: &std::path::Path) -> Result<(), String> {
        use std::os::unix::fs::MetadataExt;
        match std::fs::metadata(p) {
            Ok(m) if m.uid() != unsafe { libc::getuid() } => {
                Err(format!("{} is not owned by you", p.display()))
            }
            _ => Ok(()),
        }
    }

    /// Reject a peer that is not us (a socket bound by another user after the path check).
    fn verify_peer(s: &UnixStream) -> Result<(), String> {
        use std::os::fd::AsRawFd;
        let fd = s.as_raw_fd();
        #[cfg(target_os = "linux")]
        let uid = {
            let mut cred = libc::ucred {
                pid: 0,
                uid: u32::MAX,
                gid: 0,
            };
            let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
            let rc = unsafe {
                libc::getsockopt(
                    fd,
                    libc::SOL_SOCKET,
                    libc::SO_PEERCRED,
                    &mut cred as *mut _ as *mut libc::c_void,
                    &mut len,
                )
            };
            (rc == 0).then_some(cred.uid)
        };
        #[cfg(not(target_os = "linux"))]
        let uid = {
            let (mut u, mut g): (libc::uid_t, libc::gid_t) = (u32::MAX, u32::MAX);
            (unsafe { libc::getpeereid(fd, &mut u, &mut g) } == 0).then_some(u)
        };
        if uid == Some(unsafe { libc::getuid() }) {
            Ok(())
        } else {
            Err("daemon socket is not owned by you".into())
        }
    }

    /// `Ok(None)`: nobody is listening (yet).
    pub fn try_connect() -> Result<Option<ClientStream>, String> {
        let p = sock_path();
        mine(&p)?;
        match UnixStream::connect(&p) {
            Ok(s) => verify_peer(&s).map(|_| Some(s)),
            Err(_) => Ok(None),
        }
    }

    /// Start the daemon: no stdin/stdout, stderr appended to its log.
    pub fn spawn_daemon() -> std::io::Result<()> {
        use std::process::{Command, Stdio};
        let log_dir = crate::proto::state_dir();
        crate::proto::private_dir(&log_dir);
        let log = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(log_dir.join("daemon.log"))
            .map(Stdio::from)
            .unwrap_or_else(|_| Stdio::null());
        let mut c = Command::new(std::env::current_exe()?);
        c.arg("__daemon")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(log);
        spawn_detached(&mut c).map(|_| ())
    }

    /// Unix daemons are started with stderr already pointing at the log.
    pub fn daemon_stderr_to(_log: &std::path::Path) {}

    /// Start a long-lived background child (descriptors are close-on-exec: nothing leaks into it).
    pub fn spawn_detached(c: &mut std::process::Command) -> std::io::Result<std::process::Child> {
        unsafe {
            c.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
        c.spawn()
    }

    pub struct Listener(tokio::net::UnixListener);

    impl Listener {
        pub fn bind() -> Result<Listener, String> {
            let path = sock_path();
            let _ = std::fs::remove_file(&path);
            let l = tokio::net::UnixListener::bind(&path)
                .map_err(|e| format!("bind {}: {e}", path.display()))?;
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
            Ok(Listener(l))
        }

        pub async fn accept(&self) -> std::io::Result<ServerStream> {
            self.0.accept().await.map(|(s, _)| s)
        }

        /// Token a request must carry (none on unix).
        pub fn token(&self) -> Option<String> {
            None
        }
    }

    pub fn remove_endpoint() {
        let _ = std::fs::remove_file(sock_path());
    }

    /// Exclusive per-user daemon lock: held while the returned file is alive.
    pub fn lock_file(path: &std::path::Path) -> Option<std::fs::File> {
        use std::os::fd::AsRawFd;
        let f = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(path)
            .ok()?;
        (unsafe { libc::flock(f.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0).then_some(f)
    }
}

#[cfg(windows)]
mod windows_impl {
    use super::endpoint_file;
    use std::net::TcpStream;
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::process::CommandExt;

    pub type ClientStream = TcpStream;
    pub type ServerStream = tokio::net::TcpStream;

    fn read_endpoint() -> Option<(u16, String)> {
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(endpoint_file()).ok()?).ok()?;
        Some((v["port"].as_u64()? as u16, v["token"].as_str()?.to_string()))
    }

    pub fn client_token() -> Option<String> {
        read_endpoint().map(|(_, t)| t)
    }

    pub fn try_connect() -> Result<Option<ClientStream>, String> {
        let Some((port, _)) = read_endpoint() else {
            return Ok(None);
        };
        // The endpoint file outlives a crashed daemon and its port could be taken by anyone: only
        // trust it while a daemon actually holds the lock (the client then never sends a request,
        // PIN included, to a stranger).
        if lock_file(&crate::proto::state_dir().join("daemon.lock")).is_some() {
            let _ = std::fs::remove_file(endpoint_file());
            return Ok(None);
        }
        match TcpStream::connect(("127.0.0.1", port)) {
            Ok(s) => {
                let _ = s.set_nodelay(true);
                Ok(Some(s))
            }
            Err(_) => Ok(None),
        }
    }

    #[repr(C)]
    struct StartupInfoW {
        cb: u32,
        reserved: *mut u16,
        desktop: *mut u16,
        title: *mut u16,
        numbers: [u32; 7],
        flags: u32,
        show_window: u16,
        reserved2_len: u16,
        reserved2: *mut u8,
        std_handles: [isize; 3],
    }

    #[repr(C)]
    struct ProcessInformation {
        process: isize,
        thread: isize,
        pid: u32,
        tid: u32,
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CreateProcessW(
            app: *const u16,
            command_line: *mut u16,
            process_attrs: *const u8,
            thread_attrs: *const u8,
            inherit_handles: i32,
            flags: u32,
            environment: *const u8,
            cwd: *const u16,
            startup: *const StartupInfoW,
            info: *mut ProcessInformation,
        ) -> i32;
        fn CloseHandle(h: isize) -> i32;
        fn SetStdHandle(which: u32, h: isize) -> i32;
    }

    /// DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP: no console (so no window), survives the client and
    /// ignores its Ctrl-C.
    const DETACHED: u32 = 0x0000_0008 | 0x0000_0200;

    /// Start a long-lived background child that survives the client and owns no console.
    pub fn spawn_detached(c: &mut std::process::Command) -> std::io::Result<std::process::Child> {
        c.creation_flags(DETACHED).spawn()
    }

    /// Start the daemon. `Command` always lets a child inherit every inheritable handle of its parent,
    /// so a daemon started that way would hold the client's stdout pipe (and whatever the caller of
    /// the client passed down) and whoever reads `fb`'s output would wait for the daemon to exit.
    /// CreateProcess with bInheritHandles = FALSE passes nothing; the daemon opens its own log.
    pub fn spawn_daemon() -> std::io::Result<()> {
        use std::os::windows::ffi::OsStrExt;
        let exe = std::env::current_exe()?;
        let wide = |s: &std::ffi::OsStr| -> Vec<u16> { s.encode_wide().chain(Some(0)).collect() };
        // the path goes in lpApplicationName too: from the command line alone it is capped at MAX_PATH
        let app = wide(exe.as_os_str());
        let mut cmd =
            wide(std::ffi::OsString::from(format!("\"{}\" __daemon", exe.display())).as_os_str());
        let startup = StartupInfoW {
            cb: std::mem::size_of::<StartupInfoW>() as u32,
            reserved: std::ptr::null_mut(),
            desktop: std::ptr::null_mut(),
            title: std::ptr::null_mut(),
            numbers: [0; 7],
            flags: 0,
            show_window: 0,
            reserved2_len: 0,
            reserved2: std::ptr::null_mut(),
            std_handles: [0; 3],
        };
        let mut info = ProcessInformation {
            process: 0,
            thread: 0,
            pid: 0,
            tid: 0,
        };
        let ok = unsafe {
            CreateProcessW(
                app.as_ptr(),
                cmd.as_mut_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                0,
                DETACHED,
                std::ptr::null(),
                std::ptr::null(),
                &startup,
                &mut info,
            )
        };
        if ok == 0 {
            return Err(std::io::Error::last_os_error());
        }
        unsafe {
            CloseHandle(info.process);
            CloseHandle(info.thread);
        }
        Ok(())
    }

    /// The daemon's stderr goes to its log (it was started without any standard handles).
    pub fn daemon_stderr_to(log: &std::path::Path) {
        use std::os::windows::io::IntoRawHandle;
        if let Ok(f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(log)
        {
            // STD_ERROR_HANDLE = -12
            unsafe {
                SetStdHandle(-12i32 as u32, f.into_raw_handle() as isize);
            }
        }
    }

    pub struct Listener {
        inner: tokio::net::TcpListener,
        token: String,
    }

    /// Unguessable per-daemon secret (the std hasher is seeded by the OS RNG).
    fn random_token() -> String {
        use std::hash::{BuildHasher, Hasher};
        (0..4)
            .map(|i| {
                let mut h = std::collections::hash_map::RandomState::new().build_hasher();
                h.write_u32(i);
                h.write_u128(
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_nanos())
                        .unwrap_or(0),
                );
                format!("{:016x}", h.finish())
            })
            .collect()
    }

    impl Listener {
        pub fn bind() -> Result<Listener, String> {
            let std_l =
                std::net::TcpListener::bind(("127.0.0.1", 0)).map_err(|e| format!("bind: {e}"))?;
            std_l.set_nonblocking(true).map_err(|e| e.to_string())?;
            let port = std_l.local_addr().map_err(|e| e.to_string())?.port();
            let token = random_token();
            std::fs::write(
                endpoint_file(),
                serde_json::json!({"port": port, "token": token}).to_string(),
            )
            .map_err(|e| format!("write endpoint: {e}"))?;
            let inner = tokio::net::TcpListener::from_std(std_l).map_err(|e| e.to_string())?;
            Ok(Listener { inner, token })
        }

        pub async fn accept(&self) -> std::io::Result<ServerStream> {
            let (s, _) = self.inner.accept().await?;
            let _ = s.set_nodelay(true);
            Ok(s)
        }

        pub fn token(&self) -> Option<String> {
            Some(self.token.clone())
        }
    }

    pub fn remove_endpoint() {
        let _ = std::fs::remove_file(endpoint_file());
    }

    /// Exclusive per-user daemon lock: a second open with share mode 0 fails while the first lives.
    pub fn lock_file(path: &std::path::Path) -> Option<std::fs::File> {
        std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .share_mode(0)
            .open(path)
            .ok()
    }
}
