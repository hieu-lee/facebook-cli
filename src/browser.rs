use crate::cdp::{Cdp, Res};
use serde_json::{Value, json};
use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;

pub const INJECT: &str = concat!(
    include_str!("../js/lib.js"),
    ";\n",
    include_str!("../js/msg.js"),
    ";\n",
    include_str!("../js/feed.js"),
    ";\n",
    include_str!("../js/ops.js"),
    ";\n",
    include_str!("../js/act.js"),
    ";\n",
    include_str!("../js/page.js")
);

pub struct Tab {
    pub target: String,
    pub session: String,
    home: std::sync::Weak<Browser>,
    armed: bool,
    /// browser generation when handed out (see `Browser::generation`)
    gen_at: u64,
    /// what the tab last showed (e.g. "messages"); lets ops reuse a warm page
    pub kind: String,
    permit: Option<tokio::sync::OwnedSemaphorePermit>,
}

/// A tab that is dropped while an op still holds it (cancel/timeout/panic) may be mid-script: close it.
impl Drop for Tab {
    fn drop(&mut self) {
        if self.armed
            && let Some(b) = self.home.upgrade()
        {
            let target = std::mem::take(&mut self.target);
            tokio::spawn(async move {
                b.owned.lock().await.remove(&target);
                let _ = b
                    .cdp
                    .call(None, "Target.closeTarget", json!({"targetId":target}))
                    .await;
            });
        }
    }
}

pub static UA: std::sync::OnceLock<String> = std::sync::OnceLock::new();

pub struct Browser {
    pub cdp: Arc<Cdp>,
    slots: Arc<tokio::sync::Semaphore>,
    /// set once this browser is known to hold a Facebook login
    pub session_ok: std::sync::atomic::AtomicBool,
    /// a page showed the login form: the imported session was revoked or expired
    pub stale_session: std::sync::atomic::AtomicBool,
    /// bumped when the logged-in account changes: tabs checked out before must not go back to the pool
    pub generation: std::sync::atomic::AtomicU64,
    /// this browser was launched with a visible window (`login --visible`)
    pub visible: std::sync::atomic::AtomicBool,
    idle: Mutex<Vec<Tab>>,
    owned: Mutex<HashSet<String>>,
}

const MAX_IDLE: usize = 6;

impl Browser {
    pub async fn init(cdp: Arc<Cdp>, _requested_visible: bool) -> Arc<Browser> {
        // What we attached to may be an older process (daemon restarted, relay dropped): its real
        // mode decides, not what was asked for. Headless Chrome announces itself in its user agent.
        let mut visible = false;
        if let Ok(v) = cdp.call(None, "Browser.getVersion", json!({})).await
            && let Some(ua) = v["userAgent"].as_str()
        {
            visible = !ua.contains("HeadlessChrome");
            let _ = UA.set(ua.replace("HeadlessChrome", "Chrome"));
        }
        // not for the visible login browser: its Facebook tab is the one the user is typing into
        if !visible
            && crate::connect::managed()
            && let Ok(r) = cdp.call(None, "Target.getTargets", json!({})).await
        {
            // a previous connection (daemon crash, dead relay) may have left tabs behind: they are all ours
            for t in r["targetInfos"].as_array().into_iter().flatten() {
                let url = t["url"].as_str().unwrap_or("");
                if t["type"] == "page"
                    && (url.contains("facebook.com") || url.contains("messenger.com"))
                {
                    let id = t["targetId"].as_str().unwrap_or("");
                    let _ = cdp
                        .call(None, "Target.closeTarget", json!({"targetId": id}))
                        .await;
                }
            }
        }
        let b = Self::new(cdp);
        b.visible
            .store(visible, std::sync::atomic::Ordering::SeqCst);
        b
    }

    pub fn new(cdp: Arc<Cdp>) -> Arc<Browser> {
        let tabs = std::env::var("FB_TABS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(10);
        // "Leave site?" / alert dialogs would freeze a tab (e.g. navigating away from a filled composer)
        let (c, mut ev) = (Arc::downgrade(&cdp), cdp.subscribe());
        tokio::spawn(async move {
            while let Ok(e) = ev.recv().await {
                if e.method == "Page.javascriptDialogOpening" {
                    // weak: this task must not keep a dead connection alive
                    let Some(c) = c.upgrade() else { break };
                    let _ = c
                        .call(
                            e.session.as_deref(),
                            "Page.handleJavaScriptDialog",
                            json!({"accept":true}),
                        )
                        .await;
                }
            }
        });
        Arc::new(Browser {
            cdp,
            slots: Arc::new(tokio::sync::Semaphore::new(tabs)),
            session_ok: Default::default(),
            stale_session: Default::default(),
            generation: Default::default(),
            visible: Default::default(),
            idle: Mutex::new(Vec::new()),
            owned: Mutex::new(HashSet::new()),
        })
    }

    pub async fn acquire(self: &Arc<Self>) -> Res<Tab> {
        self.acquire_kind("").await
    }

    /// Like `acquire`, but prefers an idle tab last released as `kind`.
    pub async fn acquire_kind(self: &Arc<Self>, kind: &str) -> Res<Tab> {
        let permit = self
            .slots
            .clone()
            .acquire_owned()
            .await
            .map_err(|e| e.to_string())?;
        loop {
            let popped = {
                let mut idle = self.idle.lock().await;
                match idle.iter().rposition(|t| t.kind == kind) {
                    Some(i) => Some(idle.remove(i)),
                    None => idle.pop(),
                }
            };
            let Some(mut t) = popped else {
                break;
            };
            // armed while probing: if this future is cancelled, the tab is closed instead of leaked
            t.armed = true;
            let alive = self
                .cdp
                .call(
                    Some(&t.session),
                    "Runtime.evaluate",
                    json!({"expression":"1"}),
                )
                .await
                .is_ok();
            // a tab pooled before an account change shows the old account: drop it, never restamp it
            let current = t.gen_at == self.generation.load(std::sync::atomic::Ordering::SeqCst);
            if alive && current {
                t.permit = Some(permit);
                return Ok(t);
            }
            // dead page (renderer crash): close its target so it is not orphaned
            self.close(t).await;
        }
        self.new_tab(Some(permit)).await
    }

    /// A fresh tab (optionally holding a `FB_TABS` slot). Creation runs in its own task, which also
    /// owns the slot: if the caller is cancelled the task still finishes, and the guard inside it
    /// closes the target and frees the slot.
    pub async fn new_tab(
        self: &Arc<Self>,
        permit: Option<tokio::sync::OwnedSemaphorePermit>,
    ) -> Res<Tab> {
        let me = self.clone();
        tokio::spawn(async move {
            // no inner timeout: cancelling here could drop the createTarget reply and orphan the tab
            let mut tab = me.create_tab().await?;
            tab.permit = permit;
            Ok(tab)
        })
        .await
        .map_err(|e| e.to_string())?
    }

    async fn create_tab(self: &Arc<Self>) -> Res<Tab> {
        let r = self
            .cdp
            .call(
                None,
                "Target.createTarget",
                json!({"url":"about:blank","newWindow":true}),
            )
            .await?;
        let target = r["targetId"].as_str().ok_or("no targetId")?.to_string();
        self.owned.lock().await.insert(target.clone());
        // the guard exists before the next await, so cancellation closes the target
        let mut tab = Tab {
            target,
            session: String::new(),
            home: Arc::downgrade(self),
            armed: true,
            gen_at: self.generation.load(std::sync::atomic::Ordering::SeqCst),
            kind: String::new(),
            permit: None,
        };
        // bounded once the guard exists: a stalled setup closes the target and frees the slot
        let setup = async {
            let r = self
                .cdp
                .call(
                    None,
                    "Target.attachToTarget",
                    json!({"targetId":tab.target,"flatten":true}),
                )
                .await?;
            tab.session = r["sessionId"].as_str().ok_or("no sessionId")?.to_string();
            let s = Some(tab.session.as_str());
            let _ = tokio::join!(
                self.cdp.call(s, "Page.enable", json!({})),
                self.cdp.call(
                    s,
                    "Emulation.setFocusEmulationEnabled",
                    json!({"enabled":true})
                ),
                self.cdp.call(
                    s,
                    "Page.addScriptToEvaluateOnNewDocument",
                    json!({"source":INJECT})
                ),
                self.cdp.call(
                    s,
                    "Emulation.setUserAgentOverride",
                    json!({"userAgent":UA.get().cloned().unwrap_or_default()})
                ),
            );
            Ok::<(), String>(())
        };
        tokio::time::timeout(std::time::Duration::from_secs(30), setup)
            .await
            .map_err(|_| "setting up a tab timed out".to_string())??;
        Ok(tab)
    }

    /// Close every pooled tab (their pages belong to a previous login).
    pub async fn close_idle(&self) {
        self.generation
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let tabs: Vec<Tab> = std::mem::take(&mut *self.idle.lock().await);
        for t in tabs {
            self.close(t).await;
        }
    }

    pub async fn idle_count(&self) -> usize {
        self.idle.lock().await.len()
    }

    pub async fn release(&self, t: Tab) {
        self.release_as(t, "").await
    }

    pub async fn release_as(&self, mut t: Tab, kind: &str) {
        t.armed = false;
        t.permit = None;
        // the account changed while this tab was in use: its page belongs to the previous login
        if t.gen_at != self.generation.load(std::sync::atomic::Ordering::SeqCst) {
            self.close(t).await;
            return;
        }
        t.kind = kind.to_string();
        let mut idle = self.idle.lock().await;
        if idle.len() < MAX_IDLE {
            idle.push(t);
            return;
        }
        drop(idle);
        self.close(t).await;
    }

    pub async fn close(&self, mut t: Tab) {
        t.armed = false;
        t.permit = None;
        self.owned.lock().await.remove(&t.target);
        let _ = self
            .cdp
            .call(None, "Target.closeTarget", json!({"targetId":t.target}))
            .await;
    }

    pub async fn close_all(&self) {
        let ids: Vec<String> = self.owned.lock().await.drain().collect();
        for id in ids {
            let _ = self
                .cdp
                .call(None, "Target.closeTarget", json!({"targetId":id}))
                .await;
        }
    }

    pub async fn goto(&self, t: &Tab, url: &str) -> Res<()> {
        let mut rx = self.cdp.subscribe();
        let r = self
            .cdp
            .call(Some(&t.session), "Page.navigate", json!({"url":url}))
            .await?;
        if let Some(e) = r.get("errorText").and_then(Value::as_str) {
            return Err(format!("navigate: {e}"));
        }
        // a fragment-only change stays in the same document: no load event will ever come
        if r.get("loaderId").is_none() {
            return self.check_logged_in(t).await;
        }
        let deadline = tokio::time::sleep(Duration::from_secs(30));
        tokio::pin!(deadline);
        loop {
            tokio::select! {
                ev = rx.recv() => match ev {
                    Ok(ev) if ev.session.as_deref() == Some(&t.session) && ev.method == "Page.domContentEventFired" => return self.check_logged_in(t).await,
                    Ok(_) => {}
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                    Err(_) => return Err("chrome connection closed".into()),
                },
                _ = &mut deadline => return self.check_logged_in(t).await,
            }
        }
    }

    /// After loading a Facebook page: the login form means the session is gone.
    async fn check_logged_in(&self, t: &Tab) -> Res<()> {
        let out = self
            .eval(t, "(location.hostname==='facebook.com'||location.hostname.endsWith('.facebook.com'))&&(!!document.querySelector('input[name=pass]')||/^\\/(?:login(?:\\.php)?|checkpoint)(?:\\/|$)/.test(location.pathname))")
            .await
            .unwrap_or(Value::Bool(false));
        if out == Value::Bool(true) {
            self.session_ok
                .store(false, std::sync::atomic::Ordering::SeqCst);
            self.stale_session
                .store(true, std::sync::atomic::Ordering::SeqCst);
            return Err(crate::session::NOT_LOGGED_IN.into());
        }
        Ok(())
    }

    pub async fn eval(&self, t: &Tab, expr: &str) -> Res<Value> {
        let r = self
            .cdp
            .call(
                Some(&t.session),
                "Runtime.evaluate",
                json!({"expression":expr,"awaitPromise":true,"returnByValue":true}),
            )
            .await?;
        if let Some(ex) = r.get("exceptionDetails") {
            let msg = ex["exception"]["description"]
                .as_str()
                .or(ex["text"].as_str())
                .unwrap_or("js exception");
            return Err(format!("js: {msg}"));
        }
        Ok(r["result"].get("value").cloned().unwrap_or(Value::Null))
    }

    pub async fn insert_text(&self, t: &Tab, text: &str) -> Res<()> {
        self.cdp
            .call(Some(&t.session), "Input.insertText", json!({"text":text}))
            .await
            .map(|_| ())
    }

    pub async fn key(&self, t: &Tab, key: &str, code: &str, vk: u32, modifiers: u32) -> Res<()> {
        let key = if modifiers & 8 != 0 && key.len() == 1 {
            const LOWER: &str = "abcdefghijklmnopqrstuvwxyz1234567890-=[]\\;',./`";
            const UPPER: &str = "ABCDEFGHIJKLMNOPQRSTUVWXYZ!@#$%^&*()_+{}|:\"<>?~";
            LOWER.find(key).map(|i| &UPPER[i..i + 1]).unwrap_or(key)
        } else {
            key
        };
        let text = (modifiers & 7 == 0 && (key.len() == 1 || key == "Enter"))
            .then_some(if key == "Enter" { "\r" } else { key });
        let mac = UA.get().is_some_and(|ua| ua.contains("Macintosh"));
        let commands = crate::keys::commands(mac, code, modifiers)?;
        for ty in [
            if text.is_some() {
                "keyDown"
            } else {
                "rawKeyDown"
            },
            "keyUp",
        ] {
            let mut params = json!({"type":ty,"key":key,"code":code,"windowsVirtualKeyCode":vk,"nativeVirtualKeyCode":vk,"modifiers":modifiers});
            if ty == "keyDown" {
                params["text"] = json!(text);
            }
            if ty != "keyUp" && !commands.is_empty() {
                params["commands"] = json!(commands);
            }
            self.cdp
                .call(Some(&t.session), "Input.dispatchKeyEvent", params)
                .await?;
        }
        Ok(())
    }
}

impl Browser {
    pub async fn mouse(
        &self,
        t: &Tab,
        ty: &str,
        x: f64,
        y: f64,
        button: &str,
        clicks: u32,
    ) -> Res<()> {
        self.cdp
            .call(
                Some(&t.session),
                "Input.dispatchMouseEvent",
                json!({"type":ty,"x":x,"y":y,"button":button,"buttons":if ty == "mousePressed" { 1 } else { 0 },"clickCount":clicks,"pointerType":"mouse"}),
            )
            .await
            .map(|_| ())
    }

    pub async fn hover(&self, t: &Tab, x: f64, y: f64) -> Res<()> {
        self.mouse(t, "mouseMoved", x, y, "none", 0).await
    }

    pub async fn click(&self, t: &Tab, x: f64, y: f64) -> Res<()> {
        self.mouse(t, "mouseMoved", x, y, "none", 0).await?;
        self.mouse(t, "mousePressed", x, y, "left", 1).await?;
        self.mouse(t, "mouseReleased", x, y, "left", 1).await
    }
}
