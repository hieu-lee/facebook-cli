use crate::browser::Browser;
use crate::cdp::Res;
use crate::proto::{self, ERR, EXIT, OUT};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{Mutex, mpsc};

pub use crate::proto::state_dir;

#[derive(Clone)]
pub struct Out {
    tx: mpsc::UnboundedSender<Vec<u8>>,
    /// set when the client went away (Ctrl-C, timeout): mutating commands check it before the irreversible step
    cancelled: Arc<std::sync::atomic::AtomicBool>,
}

impl Out {
    pub fn cancelled(&self) -> bool {
        self.cancelled.load(std::sync::atomic::Ordering::SeqCst)
    }

    pub fn out(&self, s: impl AsRef<str>) {
        let _ = self.tx.send(proto::encode(OUT, s.as_ref().as_bytes()));
    }
    pub fn line(&self, s: impl AsRef<str>) {
        let mut v = s.as_ref().to_string();
        v.push('\n');
        self.out(v);
    }
    pub fn err(&self, s: impl AsRef<str>) {
        let _ = self.tx.send(proto::encode(ERR, s.as_ref().as_bytes()));
    }
    fn exit(&self, code: u8) {
        let _ = self.tx.send(proto::encode(EXIT, &[code]));
    }
}

pub struct Daemon {
    /// shared by every mutating command for its whole run, exclusive while the account is replaced
    pub account: tokio::sync::RwLock<()>,
    /// a `login --visible` is waiting for the user: ordinary commands must not run in its browser
    pub login_active: std::sync::atomic::AtomicBool,
    /// request secret (Windows only; see ipc)
    pub token: Option<String>,
    /// serializes browser (re)creation and the headless/visible switch of `login --visible`
    pub gate: Mutex<()>,
    /// serializes session imports (two concurrent ones could close each other's source Chrome)
    pub import_lock: Mutex<()>,
    pub chat_scan: Mutex<()>,
    pub feed: Arc<crate::feed::FeedBuf>,
    inflight: std::sync::atomic::AtomicUsize,
    last: std::sync::Mutex<std::time::Instant>,
    pub quit_browser: std::sync::atomic::AtomicBool,
    /// set by `stop`/`quit`; the connection handler triggers shutdown after the reply is flushed
    pub stop_requested: std::sync::atomic::AtomicBool,
    pub refs: crate::refs::Refs,
    pub chat_cache: Mutex<Option<crate::messenger::ChatCache>>,
    browser: Mutex<Option<Arc<Browser>>>,
    pub shutdown: tokio::sync::Notify,
}

impl Daemon {
    /// Forget everything tied to the previous login (chat list, feed buffer).
    pub async fn reset_account_caches(&self) {
        *self.chat_cache.lock().await = None;
        let _ = std::fs::remove_file(self.chats_file());
        self.feed.clear().await;
        // warm tabs still show the previous account's pages (the messages tab is reused without reloading)
        let b = self.browser.lock().await.clone();
        if let Some(b) = b {
            b.close_idle().await;
        }
    }

    pub fn chats_file(&self) -> PathBuf {
        state_dir().join("chats.tsv")
    }

    /// The browser, with a Facebook login guaranteed (imported silently from the user's Chrome if needed).
    pub async fn browser(&self, out: &Out) -> Res<Arc<Browser>> {
        let b = self.browser_show(false).await?;
        crate::session::ensure(self, &b, out).await?;
        Ok(b)
    }

    pub async fn browser_show(&self, show: bool) -> Res<Arc<Browser>> {
        let _gate = self.gate.lock().await;
        self.browser_show_inner(show).await
    }

    /// `browser_show` for a caller that already holds `gate`.
    pub async fn browser_show_inner(&self, show: bool) -> Res<Arc<Browser>> {
        // an ordinary command must never run in (or reconnect to) the visible login browser
        if !show && self.login_active.load(std::sync::atomic::Ordering::SeqCst) {
            return Err("a visible login is in progress: finish it (or Ctrl-C it) first".into());
        }
        let mut g = self.browser.lock().await;
        if let Some(b) = g.as_ref()
            && !b.cdp.closed.load(std::sync::atomic::Ordering::SeqCst)
        {
            let visible = b.visible.load(std::sync::atomic::Ordering::SeqCst);
            // (a browser given via FB_CDP is the user's own and is always "visible": use it as is)
            if !(visible && !show) || !crate::connect::managed() {
                return Ok(b.clone());
            }
            // an ordinary command must never run in the visible login browser
            if self.login_active.load(std::sync::atomic::Ordering::SeqCst) {
                return Err(
                    "a visible login is in progress: finish it (or Ctrl-C it) first".into(),
                );
            }
            // a visible browser outlived its login (cancelled/timed out): back to headless
            let old = g.take();
            if let Some(old) = old
                && crate::connect::managed()
            {
                let _ = tokio::time::timeout(
                    std::time::Duration::from_secs(4),
                    old.cdp.call(None, "Browser.close", serde_json::json!({})),
                )
                .await;
                tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
            }
        }
        let cdp = crate::connect::open(show).await?;
        let mut b = Browser::init(cdp, show).await;
        // we may have attached to a leftover visible Chrome (e.g. after `fb stop` during a visible
        // login): ordinary commands need the hidden one
        if !show && b.visible.load(std::sync::atomic::Ordering::SeqCst) && crate::connect::managed()
        {
            let _ = tokio::time::timeout(
                std::time::Duration::from_secs(4),
                b.cdp.call(None, "Browser.close", serde_json::json!({})),
            )
            .await;
            tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
            let cdp = crate::connect::open(false).await?;
            b = Browser::init(cdp, false).await;
        }
        *g = Some(b.clone());
        Ok(b)
    }

    pub async fn drop_browser(&self, quit: bool) {
        // every step is bounded: an unresponsive Chrome must never keep the daemon (and its lock) alive
        let t = std::time::Duration::from_secs(4);
        let taken = match tokio::time::timeout(t, self.browser.lock()).await {
            Ok(mut g) => g.take(),
            Err(_) => None, // a stuck connect holds the lock; the daemon exits regardless
        };
        if let Some(b) = taken {
            let _ = tokio::time::timeout(t, b.close_all()).await;
            if quit && crate::connect::managed() {
                let close = b.cdp.call(None, "Browser.close", serde_json::json!({}));
                let _ = tokio::time::timeout(t, close).await;
                tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
            }
        }
    }
}

/// The caller has already counted this request in `inflight` (so idle shutdown cannot race the spawn).
async fn handle(d: Arc<Daemon>, stream: crate::ipc::ServerStream) {
    handle_inner(&d, stream).await;
    *d.last.lock().unwrap() = std::time::Instant::now();
    d.inflight.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
}

async fn handle_inner(d: &Arc<Daemon>, stream: crate::ipc::ServerStream) {
    let (r, mut w) = tokio::io::split(stream);
    let mut line = String::new();
    let mut reader = BufReader::new(r);
    if reader.read_line(&mut line).await.unwrap_or(0) == 0 {
        return;
    }
    let cancelled = Arc::new(std::sync::atomic::AtomicBool::new(false));
    {
        // the client sends nothing after the request: EOF means it is gone
        let flag = cancelled.clone();
        tokio::spawn(async move {
            let mut buf = [0u8; 64];
            while matches!(reader.read(&mut buf).await, Ok(n) if n > 0) {}
            flag.store(true, std::sync::atomic::Ordering::SeqCst);
        });
    }
    let (tx, mut rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let out = Out { tx, cancelled };
    let writer = tokio::spawn(async move {
        while let Some(f) = rx.recv().await {
            if w.write_all(&f).await.is_err() {
                break;
            }
        }
    });
    let req: serde_json::Value = serde_json::from_str(&line).unwrap_or_default();
    // Windows has no peer credentials: the request must carry the per-daemon secret
    if let Some(want) = &d.token
        && req["token"].as_str() != Some(want.as_str())
    {
        out.err("error: bad token\n");
        out.exit(1);
        drop(out);
        let _ = writer.await;
        return;
    }
    let argv: Vec<String> = req["argv"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    let cwd = req["cwd"].as_str().unwrap_or("/").to_string();
    let code = if let Some(lines) = req["batch"].as_array() {
        let lines: Vec<String> = lines
            .iter()
            .filter_map(|x| x.as_str().map(String::from))
            .collect();
        batch(d, &lines, &cwd, &out).await
    } else {
        run_one(d, &argv, &cwd, &out).await
    };
    out.exit(code);
    drop(out);
    let _ = writer.await;
    if d.stop_requested.load(std::sync::atomic::Ordering::SeqCst) {
        d.shutdown.notify_one();
    }
}

async fn run_one(d: &Arc<Daemon>, argv: &[String], cwd: &str, out: &Out) -> u8 {
    match crate::cmd::run(d, argv, cwd, out).await {
        Ok(()) => 0,
        Err(e) => {
            out.err(format!("error: {e}\n"));
            1
        }
    }
}

/// Secrets must not be echoed into transcripts: `unlock <PIN>` is shown as `unlock ***`.
fn redact(line: &str) -> String {
    let word = crate::proto::shlex(line).and_then(|w| w.into_iter().next());
    if word.as_deref() == Some("unlock") || line.trim_start().starts_with("unlock") {
        "unlock ***".into()
    } else {
        line.to_string()
    }
}

/// Run many commands concurrently; print each one's output under a `## i cmd` header, in order.
async fn batch(d: &Arc<Daemon>, lines: &[String], cwd: &str, out: &Out) -> u8 {
    let mut handles = Vec::new();
    for l in lines {
        let argv = crate::proto::shlex(l);
        let (tx, mut rx) = mpsc::unbounded_channel::<Vec<u8>>();
        let sub = Out {
            tx,
            cancelled: out.cancelled.clone(),
        };
        let (d, cwd, live) = (d.clone(), cwd.to_string(), out.clone());
        handles.push(tokio::spawn(async move {
            // stdout is grouped per command; stderr (Allow-click / checkbox instructions) goes out at once
            let collector = tokio::spawn(async move {
                let mut text = String::new();
                while let Some(f) = rx.recv().await {
                    let body = String::from_utf8_lossy(&f[5..]).into_owned();
                    match f[0] {
                        OUT => text.push_str(&body),
                        ERR => live.err(body),
                        _ => {}
                    }
                }
                text
            });
            let res = match &argv {
                Some(argv) => crate::cmd::run(&d, argv, &cwd, &sub).await,
                None => Err("unterminated quote or trailing backslash".into()),
            };
            drop(sub);
            let mut text = collector.await.unwrap_or_default();
            let code = match res {
                Ok(()) => 0,
                Err(e) => {
                    text.push_str(&format!("! error: {e}\n"));
                    1
                }
            };
            (code, text)
        }));
    }
    let mut worst = 0;
    for (i, h) in handles.into_iter().enumerate() {
        out.line(format!("## {} {}", i + 1, redact(&lines[i])));
        match h.await {
            Ok((code, text)) => {
                worst = worst.max(code);
                out.out(text);
            }
            Err(e) => {
                worst = 1;
                out.line(format!("! task failed: {e}"));
            }
        }
    }
    worst
}

#[tokio::main]
async fn run() {
    let dir = state_dir();
    proto::private_dir(&dir);
    // one daemon per user: the lock makes concurrent first calls safe (losers just exit)
    let Some(_lock) = crate::ipc::lock_file(&dir.join("daemon.lock")) else {
        return;
    };
    let listener = match crate::ipc::Listener::bind() {
        Ok(l) => l,
        Err(e) => {
            eprintln!("{e}");
            return;
        }
    };
    let d = Arc::new(Daemon {
        token: listener.token(),
        feed: Default::default(),
        chat_scan: Mutex::new(()),
        gate: Mutex::new(()),
        account: tokio::sync::RwLock::new(()),
        login_active: Default::default(),
        import_lock: Mutex::new(()),
        inflight: Default::default(),
        last: std::sync::Mutex::new(std::time::Instant::now()),
        quit_browser: Default::default(),
        stop_requested: Default::default(),
        refs: crate::refs::Refs::load(dir.join("refs.tsv")),
        chat_cache: Mutex::new(crate::messenger::ChatCache::load(&dir.join("chats.tsv"))),
        browser: Mutex::new(None),
        shutdown: tokio::sync::Notify::new(),
    });
    let idle = std::env::var("FB_IDLE")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(900u64);
    let mut tick = tokio::time::interval(std::time::Duration::from_secs(20));
    loop {
        tokio::select! {
            _ = tick.tick() => {
                let quiet = d.inflight.load(std::sync::atomic::Ordering::SeqCst) == 0 && d.last.lock().unwrap().elapsed().as_secs() >= idle;
                if quiet {
                    d.quit_browser.store(true, std::sync::atomic::Ordering::SeqCst);
                    break;
                }
            }
            r = listener.accept() => {
                if let Ok(s) = r {
                    d.inflight.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    tokio::spawn(handle(d.clone(), s));
                }
            }
            _ = d.shutdown.notified() => break,
        }
    }
    crate::ipc::remove_endpoint();
    d.drop_browser(d.quit_browser.load(std::sync::atomic::Ordering::SeqCst))
        .await;
}

pub fn main() {
    run();
}
