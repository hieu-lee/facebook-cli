use crate::cdp::{Cdp, Res};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;
use tokio::net::TcpStream;
use tokio::process::Command;

/// A dedicated Chrome profile driven over CDP. No consent dialog: we start Chrome ourselves.
struct Plan {
    exe: String,
    /// profile dir as seen from this process
    profile: PathBuf,
    /// profile dir as seen by chrome (Windows path under WSL)
    profile_arg: String,
    /// chrome runs on Windows and is only reachable through powershell.exe
    windows: bool,
}

fn is_wsl() -> bool {
    std::fs::read_to_string("/proc/version")
        .map(|s| s.to_lowercase().contains("microsoft"))
        .unwrap_or(false)
}

/// Windows Chrome under WSL: (windows path, unix path). Covers system-wide and per-user installs.
fn win_chrome() -> Option<(String, PathBuf)> {
    let la = win_local_app_data().ok();
    let mut c: Vec<(String, PathBuf)> = vec![
        (
            "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe".into(),
            "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe".into(),
        ),
        (
            "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe".into(),
            "/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe".into(),
        ),
    ];
    if let Some((win, unix)) = la {
        c.push((
            format!("{win}\\Google\\Chrome\\Application\\chrome.exe"),
            unix.join("Google/Chrome/Application/chrome.exe"),
        ));
    }
    c.into_iter().find(|(_, u)| u.exists())
}

/// (windows path, unix path) of %LOCALAPPDATA% when running under WSL.
fn win_local_app_data() -> Res<(String, PathBuf)> {
    // powershell, not `cmd /c echo %VAR%`: cmd re-parses the expanded value (an `&` in a user name
    // would truncate it) and prints in the OEM codepage
    let la = std::process::Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "[Console]::OutputEncoding=[Text.Encoding]::UTF8; [Environment]::GetFolderPath('LocalApplicationData')",
        ])
        .current_dir("/mnt/c")
        .output()
        .map_err(|e| format!("powershell.exe: {e}"))?;
    let win = String::from_utf8_lossy(&la.stdout).trim().to_string();
    if !la.status.success() || win.is_empty() {
        return Err("could not read the Windows LocalAppData folder".into());
    }
    let unix = std::process::Command::new("wslpath")
        .args(["-u", &win])
        .output()
        .map_err(|e| format!("wslpath: {e}"))?;
    if !unix.status.success() {
        return Err(format!("wslpath failed for {win}"));
    }
    Ok((
        win,
        PathBuf::from(String::from_utf8_lossy(&unix.stdout).trim()),
    ))
}

/// Chrome on native Windows: machine-wide or per-user install.
#[cfg(windows)]
fn native_windows_chrome() -> Option<String> {
    let roots = ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"];
    roots.iter().find_map(|r| {
        let p = PathBuf::from(std::env::var(r).ok()?).join("Google/Chrome/Application/chrome.exe");
        p.exists().then(|| p.to_string_lossy().into_owned())
    })
}

/// Chrome/Chromium executables on Linux and macOS (system-wide and per-user installs).
#[cfg(not(windows))]
fn unix_chromes() -> Vec<String> {
    let home = std::env::var("HOME").unwrap_or_default();
    let mut v: Vec<String> = [
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ]
    .map(String::from)
    .to_vec();
    v.push(format!(
        "{home}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    ));
    v.push(format!(
        "{home}/Applications/Chromium.app/Contents/MacOS/Chromium"
    ));
    v.retain(|p| std::path::Path::new(p).exists());
    v
}

fn plan() -> Res<Plan> {
    #[cfg(not(windows))]
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
    if is_wsl()
        && let Some((exe, _)) = win_chrome()
    {
        let (win, unix) = win_local_app_data()?;
        let (profile, profile_arg) = match std::env::var("FB_PROFILE") {
            // a /mnt/... path: convert for chrome.exe
            Ok(p) => {
                let w = std::process::Command::new("wslpath")
                    .args(["-w", &p])
                    .output()
                    .map_err(|e| format!("wslpath: {e}"))?;
                (
                    PathBuf::from(p),
                    String::from_utf8_lossy(&w.stdout).trim().to_string(),
                )
            }
            Err(_) => (unix.join("fb/chrome"), format!("{win}\\fb\\chrome")),
        };
        return Ok(Plan {
            exe,
            profile,
            profile_arg,
            windows: true,
        });
    }
    #[cfg(windows)]
    {
        let exe = native_windows_chrome().ok_or("Chrome not found (install Google Chrome)")?;
        let profile = std::env::var("FB_PROFILE")
            .map(PathBuf::from)
            .unwrap_or_else(|_| crate::proto::state_dir().join("chrome"));
        #[allow(clippy::needless_return)] // the statements below are compiled out on Windows
        return Ok(Plan {
            exe,
            profile_arg: profile.to_string_lossy().into_owned(),
            profile,
            windows: false,
        });
    }
    #[cfg(not(windows))]
    let exe = unix_chromes()
        .into_iter()
        .next()
        .ok_or("Chrome not found (install Google Chrome)")?;
    #[cfg(not(windows))]
    {
        let profile = std::env::var("FB_PROFILE")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from(&home).join(".cache/fb/chrome"));
        Ok(Plan {
            exe,
            profile_arg: profile.to_string_lossy().into_owned(),
            profile,
            windows: false,
        })
    }
}

pub fn read_active_port(dir: &std::path::Path) -> Option<(u16, String)> {
    let s = std::fs::read_to_string(dir.join("DevToolsActivePort")).ok()?;
    let mut l = s.lines();
    let port = l.next()?.trim().parse().ok()?;
    let path = l.next()?.trim().to_string();
    Some((port, path))
}

const RELAY_PS: &str = "$c=New-Object Net.Sockets.TcpClient('127.0.0.1',__PORT__);$c.NoDelay=$true;$s=$c.GetStream();$i=[Console]::OpenStandardInput();$o=[Console]::OpenStandardOutput();$a=$i.CopyToAsync($s);$b=$s.CopyToAsync($o);[Threading.Tasks.Task]::WaitAny(@($a,$b))|Out-Null";

async fn dial(host: &str, port: u16, path: &str, windows: bool) -> Res<Arc<Cdp>> {
    let url = format!("ws://{host}:{port}{path}");
    if !windows {
        let tcp = TcpStream::connect((host, port))
            .await
            .map_err(|e| format!("connect: {e}"))?;
        let _ = tcp.set_nodelay(true);
        return Cdp::connect(tcp, &url).await;
    }
    let script = RELAY_PS.replace("__PORT__", &port.to_string());
    let mut child = Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("spawn powershell.exe: {e}"))?;
    let stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    tokio::spawn(async move {
        let _ = child.wait().await;
    });
    Cdp::connect(tokio::io::join(stdout, stdin), &url).await
}

async fn launch(p: &Plan, show: bool) -> Res<()> {
    // a failed attach does not mean Chrome is gone: only a stale file of a stopped browser is removed
    // (launching into a live Chrome would not recreate it)
    let live = UserChrome {
        dir: p.profile.clone(),
        exe: String::new(),
        windows: p.windows,
    };
    if !live.running() {
        live.clear_endpoint();
    }
    let _ = std::fs::create_dir_all(&p.profile);
    let mut args: Vec<String> = vec![
        "--remote-debugging-port=0".into(),
        // Start-Process joins its argument list with spaces, so a Windows path must carry its own quotes
        if p.windows {
            format!("--user-data-dir=\"{}\"", p.profile_arg)
        } else {
            format!("--user-data-dir={}", p.profile_arg)
        },
        "--no-first-run".into(),
        "--no-default-browser-check".into(),
        "--disable-background-timer-throttling".into(),
        "--disable-renderer-backgrounding".into(),
        "--disable-backgrounding-occluded-windows".into(),
        "--disable-features=CalculateNativeWinOcclusion".into(),
        "--hide-crash-restore-bubble".into(),
        "--disable-blink-features=AutomationControlled".into(),
        "--window-size=1366,900".into(),
    ];
    if !show {
        args.push("--headless=new".into());
    }
    args.push("about:blank".into());
    spawn_process(&p.exe, &args, p.windows).await
}

/// Start a detached process (through powershell.exe for Windows binaries under WSL).
async fn spawn_process(exe: &str, args: &[String], windows: bool) -> Res<()> {
    if windows {
        // Start-Process joins its argument list with spaces: callers pre-quote values that contain spaces
        let list = args
            .iter()
            .map(|a| format!("'{}'", a.replace('\'', "''")))
            .collect::<Vec<_>>()
            .join(",");
        let script = format!(
            "Start-Process -FilePath '{}' -ArgumentList {list}",
            exe.replace('\'', "''")
        );
        let st = Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await
            .map_err(|e| format!("powershell.exe: {e}"))?;
        if !st.success() {
            return Err(format!("could not start {exe}"));
        }
    } else {
        let mut c = std::process::Command::new(exe);
        c.args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        crate::ipc::detach(&mut c);
        let mut child = c.spawn().map_err(|e| format!("launch chrome: {e}"))?;
        // reap it when it exits (a closed visible login Chrome would otherwise stay a zombie)
        std::thread::spawn(move || {
            let _ = child.wait();
        });
    }
    Ok(())
}

/// Is this process id alive? (EPERM means it exists but is not ours.)
#[cfg(unix)]
fn pid_alive(pid: i32) -> bool {
    let r = unsafe { libc::kill(pid, 0) };
    r == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// Windows uses the exclusive `lockfile` instead of a SingletonLock; this is never reached there.
#[cfg(not(unix))]
fn pid_alive(_pid: i32) -> bool {
    true
}

/// The user's everyday Chrome (default profile), as opposed to our dedicated one.
pub struct UserChrome {
    pub dir: PathBuf,
    pub exe: String,
    pub windows: bool,
}

/// Every installed user Chrome data dir (native Windows).
#[cfg(windows)]
pub fn user_chromes() -> Vec<UserChrome> {
    let mut v = Vec::new();
    if let (Some(exe), Ok(la)) = (native_windows_chrome(), std::env::var("LOCALAPPDATA")) {
        v.push(UserChrome {
            dir: PathBuf::from(la).join("Google/Chrome/User Data"),
            exe,
            windows: false,
        });
    }
    v
}

/// Every installed user Chrome/Chromium data dir, most likely first.
#[cfg(not(windows))]
pub fn user_chromes() -> Vec<UserChrome> {
    let home = std::env::var("HOME").unwrap_or_default();
    // Chrome's own rule for the Linux config root
    let config = std::env::var("CHROME_CONFIG_HOME")
        .or_else(|_| std::env::var("XDG_CONFIG_HOME"))
        .ok()
        .filter(|d| !d.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(&home).join(".config"));
    let mut v = Vec::new();
    if is_wsl()
        && let Some((exe, _)) = win_chrome()
    {
        if let Ok((_, la)) = win_local_app_data() {
            v.push(UserChrome {
                dir: la.join("Google/Chrome/User Data"),
                exe,
                windows: true,
            });
        }
        return v;
    }
    // an explicit data dir (Chrome honours it, and a Chrome we launch inherits it)
    if let Ok(dir) = std::env::var("CHROME_USER_DATA_DIR")
        && !dir.is_empty()
        && let Some(exe) = unix_chromes().into_iter().next()
        && PathBuf::from(&dir).join("Local State").exists()
    {
        v.push(UserChrome {
            dir: dir.into(),
            exe,
            windows: false,
        });
    }
    // (data dir, executable names that use it); the macOS dirs are relative to $HOME, the rest to the config root
    let installed = unix_chromes();
    let exe_for = |needles: &[&str]| {
        installed
            .iter()
            .find(|p| needles.iter().any(|n| p.contains(n)))
            .cloned()
    };
    for (dir, exe) in [
        (config.join("google-chrome"), exe_for(&["google-chrome"])),
        (config.join("chromium"), exe_for(&["/chromium"])),
        (
            PathBuf::from(&home).join("Library/Application Support/Google/Chrome"),
            exe_for(&["Google Chrome.app"]),
        ),
        (
            PathBuf::from(&home).join("Library/Application Support/Chromium"),
            exe_for(&["Chromium.app"]),
        ),
    ] {
        let Some(exe) = exe else { continue };
        // one entry per data dir
        if dir.join("Local State").exists() && !v.iter().any(|u: &UserChrome| u.dir == dir) {
            v.push(UserChrome {
                dir,
                exe,
                windows: false,
            });
        }
    }
    v
}

impl UserChrome {
    /// (port, ws path) of its remote-debugging endpoint, if it exposes one.
    pub fn endpoint(&self) -> Option<(u16, String)> {
        read_active_port(&self.dir)
    }

    /// Forget a stale endpoint file (Chrome does not delete it when its debugging server stops).
    pub fn clear_endpoint(&self) {
        let _ = std::fs::remove_file(self.dir.join("DevToolsActivePort"));
    }

    /// Is a browser currently using this data dir?
    pub fn running(&self) -> bool {
        if self.windows || cfg!(windows) {
            // Chrome keeps `lockfile` open exclusively while it runs
            std::fs::OpenOptions::new()
                .write(true)
                .open(self.dir.join("lockfile"))
                .is_err()
                && self.dir.join("lockfile").exists()
        } else {
            // SingletonLock -> "host-pid"; after an unclean exit the link outlives the process
            match std::fs::read_link(self.dir.join("SingletonLock")) {
                Ok(target) => {
                    let t = target.to_string_lossy();
                    match t.rsplit('-').next().and_then(|p| p.parse::<i32>().ok()) {
                        Some(pid) => pid_alive(pid),
                        None => true,
                    }
                }
                Err(_) => false,
            }
        }
    }

    /// Open `url` in this Chrome (a new tab if it is already running). `fresh`: it was not running,
    /// so a leftover endpoint file is stale.
    pub async fn launch(&self, url: &str, fresh: bool) -> Res<()> {
        if fresh {
            self.clear_endpoint();
        }
        spawn_process(&self.exe, &[url.to_string()], self.windows).await
    }

    /// Connect to its debugging endpoint (blocks until the user accepts Chrome's consent dialog).
    pub async fn connect(&self, port: u16, path: &str) -> Res<Arc<Cdp>> {
        dial("127.0.0.1", port, path, self.windows).await
    }

    /// Flip Chrome's "allow remote debugging" switch in Local State. Only safe while Chrome is closed.
    pub fn enable_remote_debugging(&self) -> Res<()> {
        let p = self.dir.join("Local State");
        let text = std::fs::read_to_string(&p).map_err(|e| format!("{}: {e}", p.display()))?;
        let mut v: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
        v["devtools"]["remote_debugging"]["user-enabled"] = serde_json::Value::Bool(true);
        // a failed backup aborts (never edit without one); the edit itself is write-then-rename
        std::fs::write(self.dir.join("Local State.fb-backup"), &text)
            .map_err(|e| format!("cannot back up Local State: {e}"))?;
        let tmp = self.dir.join("Local State.fb-tmp");
        std::fs::write(&tmp, serde_json::to_string(&v).map_err(|e| e.to_string())?)
            .and_then(|_| std::fs::rename(&tmp, &p))
            .map_err(|e| {
                let _ = std::fs::remove_file(&tmp);
                e.to_string()
            })
    }
}

/// Dial an explicit endpoint (`FB_CDP`-style spec): port | host:port | ws://host:port/path.
pub async fn open_spec(v: &str) -> Res<Arc<Cdp>> {
    open_env(v).await
}

async fn attach_plan(p: &Plan) -> Option<Arc<Cdp>> {
    let (port, path) = read_active_port(&p.profile)?;
    dial("127.0.0.1", port, &path, p.windows).await.ok()
}

/// True when `fb` owns the Chrome it talks to (so it may close it). With `FB_CDP` the browser is the user's.
pub fn managed() -> bool {
    std::env::var("FB_CDP").is_err()
}

/// Connect to an already running Chrome without launching one.
pub async fn attach() -> Option<Arc<Cdp>> {
    if let Ok(v) = std::env::var("FB_CDP") {
        return open_env(&v).await.ok();
    }
    attach_plan(&plan().ok()?).await
}

async fn open_env(v: &str) -> Res<Arc<Cdp>> {
    // port | host:port | ws://host:port[/devtools/browser/id]
    let rest = v.strip_prefix("ws://").unwrap_or(v);
    let (hp, path) = rest.split_at(rest.find('/').unwrap_or(rest.len()));
    let (host, port) = match hp.rsplit_once(':') {
        Some((h, p)) => (h, p),
        None => ("127.0.0.1", hp),
    };
    let port: u16 = port.parse().map_err(|_| "bad FB_CDP")?;
    let loopback = matches!(host, "127.0.0.1" | "localhost");
    // Windows Chrome's loopback is not WSL's loopback: go through the powershell relay
    let relay = loopback && is_wsl() && TcpStream::connect((host, port)).await.is_err();
    let path = if !path.is_empty() {
        path.to_string()
    } else if relay {
        return Err(
            "under WSL pass the full ws:// url (the /json endpoint is not reachable)".into(),
        );
    } else {
        browser_path(host, port).await?
    };
    dial(host, port, &path, relay).await
}

async fn browser_path(host: &str, port: u16) -> Res<String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut s = TcpStream::connect((host, port))
        .await
        .map_err(|e| format!("connect {host}:{port}: {e}"))?;
    s.write_all(b"GET /json/version HTTP/1.0\r\nHost: localhost\r\n\r\n")
        .await
        .map_err(|e| e.to_string())?;
    let mut buf = String::new();
    s.read_to_string(&mut buf)
        .await
        .map_err(|e| e.to_string())?;
    let i = buf.find("/devtools/browser/").ok_or("no browser ws path")?;
    let rest = &buf[i..];
    Ok(rest[..rest.find('"').unwrap_or(rest.len())].to_string())
}

pub async fn open(show: bool) -> Res<Arc<Cdp>> {
    if let Ok(v) = std::env::var("FB_CDP") {
        return open_env(&v).await;
    }
    let p = plan()?;
    if let Some(c) = attach_plan(&p).await {
        return Ok(c);
    }
    launch(&p, show).await?;
    let t = std::time::Instant::now();
    while t.elapsed() < Duration::from_secs(20) {
        tokio::time::sleep(Duration::from_millis(100)).await;
        if let Some(c) = attach_plan(&p).await {
            return Ok(c);
        }
    }
    Err("chrome did not expose debug port".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("fb-conn-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn chrome(dir: PathBuf) -> UserChrome {
        UserChrome {
            dir,
            exe: "chrome".into(),
            windows: false,
        }
    }

    #[test]
    fn enabling_remote_debugging_edits_local_state_and_keeps_a_backup() {
        let d = tmp("ls");
        std::fs::write(
            d.join("Local State"),
            r#"{"profile":{"last_used":"Default"},"devtools":{"other":1}}"#,
        )
        .unwrap();
        chrome(d.clone()).enable_remote_debugging().unwrap();
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(d.join("Local State")).unwrap()).unwrap();
        assert_eq!(v["devtools"]["remote_debugging"]["user-enabled"], true);
        assert_eq!(v["devtools"]["other"], 1);
        assert_eq!(v["profile"]["last_used"], "Default");
        assert!(d.join("Local State.fb-backup").exists());
        let _ = std::fs::remove_dir_all(d);
    }

    #[cfg(unix)]
    #[test]
    fn endpoint_and_running_are_read_from_the_profile_dir() {
        let d = tmp("ep");
        let c = chrome(d.clone());
        assert!(c.endpoint().is_none() && !c.running());
        std::fs::write(
            d.join("DevToolsActivePort"),
            "9222\n/devtools/browser/abc\n",
        )
        .unwrap();
        assert_eq!(
            c.endpoint(),
            Some((9222, "/devtools/browser/abc".to_string()))
        );
        std::os::unix::fs::symlink(
            format!("host-{}", std::process::id()),
            d.join("SingletonLock"),
        )
        .unwrap();
        assert!(c.running());
        // a stale lock (dead pid) is not a running browser
        std::fs::remove_file(d.join("SingletonLock")).unwrap();
        std::os::unix::fs::symlink("host-2147483000", d.join("SingletonLock")).unwrap();
        assert!(!c.running());
        let _ = std::fs::remove_dir_all(d);
    }
}
