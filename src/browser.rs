use crate::cdp::{Cdp, Res};
use serde_json::{Value, json};
use std::collections::HashMap;
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
    context: Option<StoryContext>,
}

impl Tab {
    #[cfg(all(test, target_os = "linux"))]
    pub fn for_bench(session: &str) -> Tab {
        Tab {
            target: String::new(),
            session: session.into(),
            home: std::sync::Weak::new(),
            armed: false,
            gen_at: 0,
            kind: String::new(),
            permit: None,
            context: None,
        }
    }

    pub fn story_connection(&self) -> Option<Arc<Cdp>> {
        self.context.as_ref().map(|context| context.cdp.clone())
    }
}

struct StoryContext {
    id: String,
    cdp: Arc<Cdp>,
    armed: bool,
}

impl Drop for StoryContext {
    fn drop(&mut self) {
        if self.armed {
            self.cdp.close();
        }
    }
}

/// A tab that is dropped while an op still holds it (cancel/timeout/panic) may be mid-script: close it.
impl Drop for Tab {
    fn drop(&mut self) {
        if self.armed
            && let Some(b) = self.home.upgrade()
        {
            let target = std::mem::take(&mut self.target);
            let context_owned = self.context.is_some();
            tokio::spawn(async move {
                b.owned.lock().await.remove(&target);
                if !context_owned {
                    let _ = b
                        .cdp
                        .call(None, "Target.closeTarget", json!({"targetId":target}))
                        .await;
                }
            });
        }
    }
}

pub static UA: std::sync::OnceLock<String> = std::sync::OnceLock::new();

pub fn evaluation_result(r: &Value) -> Res<&Value> {
    if let Some(ex) = r.get("exceptionDetails") {
        let msg = ex["exception"]["description"]
            .as_str()
            .or(ex["text"].as_str())
            .unwrap_or("js exception");
        return Err(format!("js: {msg}"));
    }
    Ok(&r["result"])
}

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
    /// see `park_busy`
    busy: Mutex<Option<Tab>>,
    owned: Mutex<HashMap<String, Option<String>>>,
}

const MAX_IDLE: usize = 6;
const LIFECYCLE_TIMEOUT: Duration = Duration::from_secs(5);

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
            busy: Mutex::new(None),
            owned: Mutex::new(HashMap::new()),
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
            // pooled tabs are frozen (see release_as): wake this one before
            // probing, or the probe itself would stall on a frozen page
            let thawed = self.set_lifecycle(&t, false).await.is_ok();
            let alive = thawed
                && self
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
            let mut tab = me.create_tab(None).await?;
            tab.permit = permit;
            Ok(tab)
        })
        .await
        .map_err(|e| e.to_string())?
    }

    pub async fn new_story_tab(self: &Arc<Self>) -> Res<Tab> {
        self.story_tab(None).await
    }

    pub async fn acquire_story_tab(self: &Arc<Self>) -> Res<Tab> {
        let permit = self
            .slots
            .clone()
            .acquire_owned()
            .await
            .map_err(|e| e.to_string())?;
        self.story_tab(Some(permit)).await
    }

    async fn story_tab(
        self: &Arc<Self>,
        permit: Option<tokio::sync::OwnedSemaphorePermit>,
    ) -> Res<Tab> {
        let me = self.clone();
        tokio::spawn(async move {
            let owner = tokio::time::timeout(Duration::from_secs(10), crate::connect::attach())
                .await
                .map_err(|_| "connecting story session timed out".to_string())?
                .ok_or("could not connect a story session")?;
            let created = tokio::time::timeout(
                Duration::from_secs(10),
                owner.call(
                    None,
                    "Target.createBrowserContext",
                    json!({"disposeOnDetach":true}),
                ),
            )
            .await;
            let r = match created {
                Ok(Ok(result)) => result,
                Ok(Err(error)) => {
                    owner.close();
                    return Err(error);
                }
                Err(_) => {
                    owner.close();
                    return Err("creating story session timed out".into());
                }
            };
            let id = r["browserContextId"]
                .as_str()
                .ok_or("no story browser context")?
                .to_owned();
            let context = StoryContext {
                id,
                cdp: owner,
                armed: true,
            };
            let setup = async {
                let cookies = crate::session::fb_cookies(&me.cdp, false).await?;
                let cookies: Vec<_> = cookies
                    .iter()
                    .filter(|c| {
                        let domain = c["domain"].as_str().unwrap_or("").trim_start_matches('.');
                        (domain == "facebook.com" || domain.ends_with(".facebook.com"))
                            && c["partitionKey"].is_null()
                            && c["partitionKeyOpaque"] != true
                    })
                    .collect();
                if !cookies.iter().any(|c| crate::session::is_login_cookie(c)) {
                    return Err(crate::session::NOT_LOGGED_IN.into());
                }
                let params: Vec<_> = cookies
                    .into_iter()
                    .map(crate::session::cookie_param)
                    .collect();
                context
                    .cdp
                    .call(
                        None,
                        "Storage.setCookies",
                        json!({"browserContextId":context.id,"cookies":params}),
                    )
                    .await?;
                Ok::<(), String>(())
            };
            tokio::time::timeout(Duration::from_secs(10), setup)
                .await
                .map_err(|_| "preparing story session timed out".to_string())??;
            let mut tab =
                tokio::time::timeout(Duration::from_secs(10), me.create_tab(Some(context)))
                    .await
                    .map_err(|_| "creating story tab timed out".to_string())??;
            tab.permit = permit;
            Ok(tab)
        })
        .await
        .map_err(|e| e.to_string())?
    }

    async fn create_tab(self: &Arc<Self>, context: Option<StoryContext>) -> Res<Tab> {
        let params = match &context {
            Some(context) => {
                json!({"url":"about:blank","newWindow":true,"browserContextId":context.id})
            }
            None => json!({"url":"about:blank","newWindow":true}),
        };
        let r = self.cdp.call(None, "Target.createTarget", params).await?;
        let target = r["targetId"].as_str().ok_or("no targetId")?.to_string();
        self.owned
            .lock()
            .await
            .insert(target.clone(), context.as_ref().map(|c| c.id.clone()));
        // the guard exists before the next await, so cancellation closes the target
        let mut tab = Tab {
            target,
            session: String::new(),
            home: Arc::downgrade(self),
            armed: true,
            gen_at: self.generation.load(std::sync::atomic::Ordering::SeqCst),
            kind: String::new(),
            permit: None,
            context,
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
        let mut tabs: Vec<Tab> = std::mem::take(&mut *self.idle.lock().await);
        tabs.extend(self.busy.lock().await.take());
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
        // stays armed, and keeps its slot, until the tab is in the pool: a
        // release cancelled while it awaits Chrome or the lock closes the tab
        // instead of leaking it. A tab from before an account change shows the previous login.
        if self.stale(&t) {
            self.close(t).await;
            return;
        }
        t.kind = kind.to_string();
        if self.idle.lock().await.len() >= MAX_IDLE {
            self.close(t).await;
            return;
        }
        // Freeze the parked page: Facebook tabs run heavy timers, and
        // the browser is launched with background throttling disabled,
        // so an unfrozen pooled tab burns CPU the whole time it waits.
        // acquire_kind unfreezes before use; a frozen tab that Chrome
        // discards meanwhile is caught by the probe there.
        if self.set_lifecycle(&t, true).await.is_err() {
            self.close(t).await;
            return;
        }
        let mut idle = self.idle.lock().await;
        // close_idle bumps the generation before it drains the pool, so a
        // tab that passes this check under the lock is still found by it
        if idle.len() < MAX_IDLE && !self.stale(&t) {
            t.armed = false;
            t.permit = None;
            idle.push(t);
            return;
        }
        drop(idle);
        self.close(t).await;
    }

    fn stale(&self, t: &Tab) -> bool {
        t.gen_at != self.generation.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// Park a tab whose page is still doing work Facebook started (a PIN
    /// restore that keeps verifying). It stays active, since a frozen page
    /// would stop the restore, and out of the pool, since reuse would
    /// navigate it away. Only one is kept: a newer one replaces it.
    pub async fn park_busy(&self, mut t: Tab) {
        t.permit = None;
        let mut busy = self.busy.lock().await;
        // close_idle bumps the generation before it takes this slot, so a tab
        // that passes the check here is still found by it
        if self.stale(&t) {
            drop(busy);
            self.close(t).await;
            return;
        }
        t.armed = false;
        let old = busy.replace(t);
        drop(busy);
        if let Some(old) = old {
            self.close(old).await;
        }
    }

    pub async fn close(&self, mut t: Tab) {
        t.armed = false;
        let permit = t.permit.take();
        self.owned.lock().await.remove(&t.target);
        if let Some(mut context) = t.context.take() {
            let _ = tokio::time::timeout(
                Duration::from_secs(4),
                context.cdp.call(
                    None,
                    "Target.disposeBrowserContext",
                    json!({"browserContextId":context.id}),
                ),
            )
            .await;
            context.armed = false;
            context.cdp.close();
            drop(permit);
        } else {
            drop(permit);
            let _ = self
                .cdp
                .call(None, "Target.closeTarget", json!({"targetId":t.target}))
                .await;
        }
    }

    pub async fn close_all(&self) {
        let ids: Vec<_> = self.owned.lock().await.drain().collect();
        for (id, context) in ids {
            let (method, params) = match context {
                Some(context) => (
                    "Target.disposeBrowserContext",
                    json!({"browserContextId":context}),
                ),
                None => ("Target.closeTarget", json!({"targetId":id})),
            };
            let _ = self.cdp.call(None, method, params).await;
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
            if t.context.is_some() {
                return Err("story session was rejected or challenged by Facebook".into());
            }
            self.session_ok
                .store(false, std::sync::atomic::Ordering::SeqCst);
            self.stale_session
                .store(true, std::sync::atomic::Ordering::SeqCst);
            return Err(crate::session::NOT_LOGGED_IN.into());
        }
        Ok(())
    }

    pub async fn eval(&self, t: &Tab, expr: &str) -> Res<Value> {
        let mut r = self
            .cdp
            .call(
                Some(&t.session),
                "Runtime.evaluate",
                json!({"expression":expr,"awaitPromise":true,"returnByValue":true}),
            )
            .await?;
        evaluation_result(&r)?;
        // move the value out: it can be megabytes
        Ok(r.get_mut("result")
            .and_then(|result| result.get_mut("value"))
            .map(Value::take)
            .unwrap_or(Value::Null))
    }

    /// `eval` for a large `expr` that needs no JSON escaping (no `"`, `\` or control characters),
    /// e.g. a base64 literal: it goes into the request frame as is.
    pub async fn eval_unescaped(&self, t: &Tab, expr: &str) -> Res<Value> {
        debug_assert!(expr.bytes().all(|c| c >= 0x20 && c != b'"' && c != b'\\'));
        let r = self
            .cdp
            .call_json(
                Some(&t.session),
                "Runtime.evaluate",
                &[
                    "{\"expression\":\"",
                    expr,
                    "\",\"awaitPromise\":true,\"returnByValue\":true}",
                ],
            )
            .await?;
        Ok(evaluation_result(&r)?
            .get("value")
            .cloned()
            .unwrap_or(Value::Null))
    }

    pub async fn insert_text(&self, t: &Tab, text: &str) -> Res<()> {
        self.cdp
            .call(Some(&t.session), "Input.insertText", json!({"text":text}))
            .await
            .map(|_| ())
    }

    /// Freeze or unfreeze a tab's page: a frozen page runs no timers and
    /// renders nothing, so a parked background tab costs no CPU. A browser
    /// that answers with an error leaves the page as it was and is ignored,
    /// but one that never answers is an `Err`: the caller must retire the
    /// tab, since its state is unknown.
    pub async fn set_lifecycle(&self, t: &Tab, frozen: bool) -> Res<()> {
        let state = if frozen { "frozen" } else { "active" };
        tokio::time::timeout(
            LIFECYCLE_TIMEOUT,
            self.cdp.call(
                Some(&t.session),
                "Page.setWebLifecycleState",
                json!({"state": state}),
            ),
        )
        .await
        .map(drop)
        .map_err(|_| format!("page did not answer the {state} lifecycle request"))
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;

    /// Fake Chrome that numbers its targets T1, T2, ... and never answers
    /// one kind of lifecycle request (and answers the `slow_state` one only
    /// after 2s). Returns every `method:detail` it saw.
    async fn chrome_withholding(
        io: tokio::io::DuplexStream,
        withheld_state: &'static str,
        slow_state: &'static str,
    ) -> Arc<StdMutex<Vec<String>>> {
        use futures_util::{SinkExt, StreamExt};
        use tokio_tungstenite::tungstenite::Message;
        let log = Arc::new(StdMutex::new(Vec::new()));
        let seen = log.clone();
        tokio::spawn(async move {
            let mut ws = tokio_tungstenite::accept_async(io).await.unwrap();
            let mut created = 0;
            while let Some(Ok(Message::Text(text))) = ws.next().await {
                let req: Value = serde_json::from_str(text.as_str()).unwrap();
                let method = req["method"].as_str().unwrap();
                let detail = match method {
                    "Page.setWebLifecycleState" => req["params"]["state"].as_str(),
                    "Target.closeTarget" => req["params"]["targetId"].as_str(),
                    _ => None,
                };
                if let Some(detail) = detail {
                    seen.lock().unwrap().push(format!("{method}:{detail}"));
                }
                let result = match method {
                    "Page.setWebLifecycleState" if detail == Some(withheld_state) => continue,
                    "Page.setWebLifecycleState" if detail == Some(slow_state) => {
                        tokio::time::sleep(Duration::from_secs(2)).await;
                        json!({})
                    }
                    "Target.createTarget" => {
                        created += 1;
                        json!({"targetId": format!("T{created}")})
                    }
                    "Target.attachToTarget" => json!({"sessionId": "S"}),
                    _ => json!({}),
                };
                let reply = json!({"id": req["id"], "result": result});
                ws.send(Message::text(reply.to_string())).await.unwrap();
            }
        });
        log
    }

    async fn browser_with(
        withheld_state: &'static str,
        slow_state: &'static str,
    ) -> (Arc<Browser>, Arc<StdMutex<Vec<String>>>) {
        let (client_io, server_io) = tokio::io::duplex(1 << 20);
        let log = chrome_withholding(server_io, withheld_state, slow_state).await;
        let cdp = Cdp::connect(client_io, "ws://fixture.local/")
            .await
            .unwrap();
        (Browser::new(cdp), log)
    }

    async fn settle() {
        for _ in 0..40 {
            tokio::task::yield_now().await;
        }
    }

    fn calls(log: &Arc<StdMutex<Vec<String>>>) -> Vec<String> {
        log.lock().unwrap().clone()
    }

    #[tokio::test(start_paused = true)]
    async fn a_release_cancelled_during_the_freeze_closes_its_tab() {
        let (b, log) = browser_with("frozen", "").await;
        let t = b.acquire().await.unwrap();
        let cancelled = tokio::time::timeout(Duration::from_secs(1), b.release_as(t, "messages"));
        assert!(cancelled.await.is_err(), "the freeze request never answers");
        settle().await;
        assert_eq!(b.idle_count().await, 0);
        assert!(calls(&log).contains(&"Target.closeTarget:T1".to_string()));
    }

    #[tokio::test(start_paused = true)]
    async fn a_tab_that_ignores_the_freeze_is_closed_not_pooled() {
        let (b, log) = browser_with("frozen", "").await;
        let t = b.acquire().await.unwrap();
        b.release_as(t, "messages").await;
        assert_eq!(b.idle_count().await, 0);
        assert_eq!(
            calls(&log),
            ["Page.setWebLifecycleState:frozen", "Target.closeTarget:T1"]
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_pooled_tab_that_ignores_the_thaw_is_retired_for_a_new_one() {
        let (b, log) = browser_with("active", "").await;
        let t = b.acquire().await.unwrap();
        b.release_as(t, "messages").await;
        assert_eq!(b.idle_count().await, 1);
        let again = b.acquire_kind("messages").await.unwrap();
        assert_eq!(again.target, "T2");
        assert_eq!(b.idle_count().await, 0);
        assert!(calls(&log).contains(&"Target.closeTarget:T1".to_string()));
    }

    #[tokio::test(start_paused = true)]
    async fn a_busy_tab_stays_active_and_is_never_handed_out_again() {
        let (b, log) = browser_with("", "").await;
        let t = b.acquire().await.unwrap();
        b.park_busy(t).await;
        assert_eq!(b.idle_count().await, 0);
        assert_eq!(calls(&log), Vec::<String>::new());
        let next = b.acquire_kind("messages").await.unwrap();
        assert_eq!(next.target, "T2");
        // a newer busy tab replaces the older one, which is closed
        b.park_busy(next).await;
        assert_eq!(calls(&log), ["Target.closeTarget:T1"]);
        // an account change closes the busy tab too
        b.close_idle().await;
        assert_eq!(
            calls(&log),
            ["Target.closeTarget:T1", "Target.closeTarget:T2"]
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_release_keeps_its_slot_until_the_tab_is_pooled() {
        let (b, _log) = browser_with("", "frozen").await;
        let free = b.slots.available_permits();
        let t = b.acquire().await.unwrap();
        assert_eq!(b.slots.available_permits(), free - 1);
        let release = tokio::spawn({
            let b = b.clone();
            async move { b.release_as(t, "messages").await }
        });
        tokio::time::sleep(Duration::from_secs(1)).await;
        assert_eq!(b.slots.available_permits(), free - 1, "still freezing");
        release.await.unwrap();
        assert_eq!(b.slots.available_permits(), free);
        assert_eq!(b.idle_count().await, 1);
    }

    #[tokio::test(start_paused = true)]
    async fn an_account_change_during_the_freeze_closes_the_releasing_tab() {
        let (b, log) = browser_with("", "frozen").await;
        let t = b.acquire().await.unwrap();
        let release = tokio::spawn({
            let b = b.clone();
            async move { b.release_as(t, "messages").await }
        });
        tokio::time::sleep(Duration::from_secs(1)).await;
        b.close_idle().await;
        release.await.unwrap();
        assert_eq!(b.idle_count().await, 0);
        assert!(calls(&log).contains(&"Target.closeTarget:T1".to_string()));
    }
}
