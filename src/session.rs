//! Getting a logged-in session into fb's own hidden Chrome profile.
//!
//! Preferred path: read the Facebook cookies from the user's everyday Chrome once, over its
//! remote-debugging endpoint (Chrome asks the user to click Allow), and copy them into our profile.
//! After that nothing touches the user's browser again and no window ever appears.
use crate::cdp::{Cdp, Res};
use crate::connect::{self, UserChrome};
use crate::daemon::{Daemon, Out};
use serde_json::{Value, json};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// The hidden session was rejected by Facebook (logged out or expired).
pub const EXPIRED: &str =
    "the Facebook session expired: run `fb login` to renew it (one Allow click)";

pub const NOT_LOGGED_IN: &str = "not logged in to Facebook: run `fb login` (it reuses the session of your normal Chrome; one Allow click)";

fn is_fb_cookie(c: &Value) -> bool {
    let d = c["domain"].as_str().unwrap_or("").trim_start_matches('.');
    d == "facebook.com"
        || d.ends_with(".facebook.com")
        || d == "messenger.com"
        || d.ends_with(".messenger.com")
}

/// The Facebook login cookie: facebook.com or a real subdomain, never a look-alike host.
pub fn is_login_cookie(c: &Value) -> bool {
    let d = c["domain"].as_str().unwrap_or("").trim_start_matches('.');
    c["name"] == "c_user" && (d == "facebook.com" || d.ends_with(".facebook.com"))
}

fn has_login(cookies: &[Value]) -> bool {
    cookies.iter().any(is_login_cookie)
}

/// Facebook cookies of the first browser context that holds a login (`all_contexts`: also the
/// non-default ones, for import sources; a destination only counts its default context, where fb opens tabs). Chrome's default context
/// follows its last-used profile; other profiles appear as extra browser contexts.
pub(crate) async fn fb_cookies(cdp: &Cdp, all_contexts: bool) -> Res<Vec<Value>> {
    let mut contexts: Vec<Option<String>> = vec![None];
    if all_contexts && let Ok(r) = cdp.call(None, "Target.getBrowserContexts", json!({})).await {
        contexts.extend(
            r["browserContextIds"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|v| v.as_str().map(|s| Some(s.to_string()))),
        );
    }
    let mut first = None;
    for ctx in contexts {
        let params = match &ctx {
            Some(id) => json!({ "browserContextId": id }),
            None => json!({}),
        };
        let Ok(r) = cdp.call(None, "Storage.getCookies", params).await else {
            continue;
        };
        let cookies: Vec<Value> = r["cookies"]
            .as_array()
            .map(|a| a.iter().filter(|c| is_fb_cookie(c)).cloned().collect())
            .unwrap_or_default();
        if has_login(&cookies) {
            return Ok(cookies);
        }
        first.get_or_insert(cookies);
    }
    Ok(first.unwrap_or_default())
}

/// Is the browser behind `cdp` logged in?
pub async fn logged_in(cdp: &Cdp) -> bool {
    fb_cookies(cdp, false)
        .await
        .map(|c| has_login(&c))
        .unwrap_or(false)
}

/// A cookie as returned by `Storage.getCookies`, reduced to what `Storage.setCookies` accepts.
pub(crate) fn cookie_param(c: &Value) -> Value {
    let mut o = serde_json::Map::new();
    for k in [
        "name", "value", "domain", "path", "secure", "httpOnly", "sameSite", "priority",
    ] {
        if !c[k].is_null() {
            o.insert(k.into(), c[k].clone());
        }
    }
    // session cookies report expires = -1; omitting it keeps them session cookies
    if c["expires"].as_f64().unwrap_or(-1.0) > 0.0 {
        o.insert("expires".into(), c["expires"].clone());
    }
    Value::Object(o)
}

async fn write_cookies(dest: &Cdp, cookies: &[Value]) -> Res<()> {
    let list: Vec<Value> = cookies.iter().map(cookie_param).collect();
    dest.call(None, "Storage.setCookies", json!({ "cookies": list }))
        .await
        .map(|_| ())
}

/// Connect to a source browser. Chrome's consent dialog makes the handshake wait for the user.
async fn connect_source(uc: &UserChrome, port: u16, path: &str, out: &Out) -> Res<Arc<Cdp>> {
    let hint = out.clone();
    let hinter = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(1500)).await;
        hint.err("fb: Chrome is asking to allow remote debugging: click \"Allow\" (needed once, to copy your Facebook login)\n");
    });
    let wait = async {
        tokio::select! {
            r = tokio::time::timeout(Duration::from_secs(150), uc.connect(port, path)) => {
                r.map_err(|_| "timed out waiting for the Allow click in Chrome".to_string())?
            }
            _ = until_cancelled(out) => Err("cancelled by client".to_string()),
        }
    };
    let r = wait.await;
    hinter.abort();
    r
}

/// Resolves once the client that asked for this command is gone (Ctrl-C, timeout).
async fn until_cancelled(out: &Out) {
    while !out.cancelled() {
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

async fn wait_endpoint(uc: &UserChrome, secs: u64, out: &Out) -> Option<(u16, String)> {
    let t = Instant::now();
    while t.elapsed() < Duration::from_secs(secs) && !out.cancelled() {
        if let Some(e) = uc.endpoint() {
            return Some(e);
        }
        tokio::time::sleep(Duration::from_millis(400)).await;
    }
    None
}

/// Make the user's Chrome expose a debugging endpoint. Returns whether we launched it ourselves.
async fn open_endpoint(uc: &UserChrome, out: &Out) -> Res<bool> {
    if uc.running() {
        out.err("fb: in your Chrome, tick \"Allow remote debugging for this browser instance\" on the chrome://inspect/#remote-debugging tab that just opened (one time)\n");
        uc.launch("chrome://inspect/#remote-debugging", false)
            .await?;
        Ok(false)
    } else {
        uc.enable_remote_debugging()?;
        uc.launch("about:blank", true).await?;
        Ok(true)
    }
}

/// Copy the Facebook session of the user's Chrome into `dest`. `guided` may open/launch Chrome
/// to switch remote debugging on; otherwise only an already-available endpoint is used.
pub async fn import(dest: &Cdp, out: &Out, guided: bool, from: Option<&str>) -> Res<usize> {
    let (cookies, ours) = if let Some(spec) = from {
        let c = connect::open_spec(spec).await?;
        (fb_cookies(&c, true).await?, None)
    } else {
        let chromes = connect::user_chromes();
        let mut got: Option<(Vec<Value>, Option<Arc<Cdp>>)> = None;
        let mut refused = false;
        let mut reachable_logged_out = false;
        for uc in &chromes {
            if let Some((port, path)) = uc.endpoint() {
                let t = Instant::now();
                match connect_source(uc, port, &path, out).await {
                    Ok(c) => {
                        let cookies = fb_cookies(&c, true).await?;
                        // a browser without a Facebook login must not hide a later one that has it
                        if has_login(&cookies) {
                            got = Some((cookies, None));
                            break;
                        }
                        reachable_logged_out = true;
                    }
                    // Chrome answers a declined dialog with HTTP 403 (or closes late); an instant
                    // connection failure means nothing listens, i.e. the endpoint file is stale
                    Err(e) if e.contains("403") || t.elapsed() > Duration::from_secs(1) => {
                        refused = true;
                        break; // never prompt twice after a "no"
                    }
                    // a cancelled wait says nothing about the endpoint: leave a live browser's file alone
                    Err(_) if out.cancelled() => return Err("cancelled by client".into()),
                    Err(_) => uc.clear_endpoint(),
                }
            }
        }
        if got.is_none() && refused {
            // remote debugging is on but the connection failed: do not launch or open anything else
            return Err(
                "Chrome did not accept the connection: run `fb login` again and click Allow".into(),
            );
        }
        if got.is_none() && reachable_logged_out {
            return Err("your Chrome is not logged in to Facebook: log in there first (or use `fb login --visible`)".into());
        }
        if got.is_none() && guided {
            let uc = chromes
                .first()
                .ok_or("Chrome not found (use `fb login --visible`)")?;
            if out.cancelled() {
                return Err("cancelled by client".into()); // before touching the user's Chrome
            }
            let launched = open_endpoint(uc, out).await?;
            let (port, path) = wait_endpoint(uc, if launched { 40 } else { 240 }, out)
                .await
                .ok_or("Chrome did not expose remote debugging (older Chrome? use `fb login --visible`), or the login was cancelled")?;
            let c = match connect_source(uc, port, &path, out).await {
                Ok(c) => c,
                Err(e) => {
                    if launched {
                        out.err("fb: I started Chrome to read the session and it is still open; close it normally\n");
                    }
                    return Err(e);
                }
            };
            let cookies = fb_cookies(&c, true).await?;
            got = Some((cookies, launched.then_some(c)));
        }
        got.ok_or_else(|| NOT_LOGGED_IN.to_string())?
    };
    if let Some(c) = ours {
        // we started that Chrome only to read the session: put things back the way they were
        let _ = c.call(None, "Browser.close", json!({})).await;
    }
    if !has_login(&cookies) {
        return Err("your Chrome is not logged in to Facebook: log in there first (or use `fb login --visible`)".into());
    }
    if out.cancelled() {
        return Err("cancelled by client; the account was not changed".into());
    }
    write_cookies(dest, &cookies).await?;
    Ok(cookies.len())
}

/// Silent attempt used by every command: only an endpoint that already exists, never launches anything.
pub async fn ensure(d: &Daemon, b: &Arc<crate::browser::Browser>, out: &Out) -> Res<()> {
    if b.session_ok.load(std::sync::atomic::Ordering::SeqCst) {
        return Ok(());
    }
    let _one_import_at_a_time = d.import_lock.lock().await;
    if b.session_ok.load(std::sync::atomic::Ordering::SeqCst) {
        return Ok(());
    }
    let stale = b.stale_session.load(std::sync::atomic::Ordering::SeqCst);
    if stale {
        // the session worked once and was then rejected: re-importing means a new Allow dialog in the
        // user's Chrome, which only an explicit `fb login` may trigger
        return Err(EXPIRED.into());
    }
    if !logged_in(&b.cdp).await {
        // invalidate BEFORE the cookies change (commands that start from now on re-check the account),
        // and again after (see below)
        // exclusive: no mutation may run while the account is being replaced
        let _swap = d.account.write().await;
        d.reset_account_caches().await;
        if import(&b.cdp, out, false, None).await.is_err() {
            return Err(NOT_LOGGED_IN.into());
        }
        // whichever account was imported, the chats cached for a previous login are not its chats
        d.reset_account_caches().await;
    }
    b.stale_session
        .store(false, std::sync::atomic::Ordering::SeqCst);
    b.session_ok
        .store(true, std::sync::atomic::Ordering::SeqCst);
    Ok(())
}

/// Cookies prove nothing about a session Facebook has revoked: load the site once and see whether it
/// still accepts them. Only an explicit rejection counts; a network hiccup keeps the session.
async fn session_accepted(b: &Arc<crate::browser::Browser>) -> bool {
    let Ok(t) = b.new_tab(None).await else {
        return true;
    };
    !matches!(b.goto(&t, "https://www.facebook.com/").await, Err(e) if e == NOT_LOGGED_IN)
}

/// `fb login [--visible] [--from <port|ws-url>]`
pub async fn login(d: &Daemon, args: &[String], out: &Out) -> Res<()> {
    let a = crate::ops::parse(args, &["from"], &["visible"])?;
    if a.flag("visible") {
        return login_visible(d, out).await;
    }
    let b = d.browser_show(false).await?;
    let _one_import_at_a_time = d.import_lock.lock().await;
    // an explicit --from always imports: the user is asking for that browser's account
    if a.opt("from").is_none()
        && logged_in(&b.cdp).await
        && !b.stale_session.load(std::sync::atomic::Ordering::SeqCst)
        && session_accepted(&b).await
    {
        out.line(format!("logged in as {}", crate::ops::uid(d, &b).await?));
        return Ok(());
    }
    let _swap = d.account.write().await; // waits for running mutations, blocks new ones
    if out.cancelled() {
        return Err("cancelled by client; the account was not changed".into());
    }
    d.reset_account_caches().await; // before the cookies change, so in-flight mutations notice
    let n = import(&b.cdp, out, true, a.opt("from")).await?;
    // another account may have been imported: its chats are not the old account's chats
    d.reset_account_caches().await;
    b.stale_session
        .store(false, std::sync::atomic::Ordering::SeqCst);
    b.session_ok
        .store(true, std::sync::atomic::Ordering::SeqCst);
    out.line(format!(
        "logged in as {} (copied {n} cookies from your Chrome; nothing else changed)",
        crate::ops::uid(d, &b).await?
    ));
    Ok(())
}

/// Close the visible login browser however it is reachable (our handle may be dead after a relay drop).
async fn teardown_visible(d: &Daemon) {
    d.drop_browser(true).await;
    if connect::managed()
        && let Some(c) = connect::attach().await
    {
        let _ = tokio::time::timeout(
            Duration::from_secs(4),
            c.call(None, "Browser.close", json!({})),
        )
        .await;
    }
}

/// Fallback: a visible window of our own profile, for people who are not logged in anywhere.
async fn login_visible(d: &Daemon, out: &Out) -> Res<()> {
    if !connect::managed() {
        return Err("--visible needs fb's own browser: unset FB_CDP".into());
    }
    // one visible login at a time: a second would close the first one's window
    // a second visible login must not queue behind the first for ages (the command time limit would
    // cut it off mid-way, after its window opened)
    let _one_login = tokio::time::timeout(Duration::from_secs(60), d.import_lock.lock())
        .await
        .map_err(|_| {
            "another login is already in progress; finish or cancel it first".to_string()
        })?;
    d.login_active
        .store(true, std::sync::atomic::Ordering::SeqCst);
    // cleared even if this future is cancelled (command timeout, client gone)
    struct Active<'a>(&'a std::sync::atomic::AtomicBool);
    impl Drop for Active<'_> {
        fn drop(&mut self) {
            self.0.store(false, std::sync::atomic::Ordering::SeqCst);
        }
    }
    let _active = Active(&d.login_active);
    if out.cancelled() {
        return Err("cancelled by client; the session was not changed".into());
    }
    // close the headless browser and open the visible one without anyone slipping in between
    let gate = d.gate.lock().await;
    d.drop_browser(true).await;
    if connect::managed()
        && let Some(c) = connect::attach().await
    {
        let _ = c.call(None, "Browser.close", json!({})).await;
        tokio::time::sleep(Duration::from_millis(2500)).await;
    }
    let b = match d.browser_show_inner(true).await {
        Ok(b) => b,
        Err(e) => {
            // Chrome may have opened its window without us getting a handle: close it
            teardown_visible(d).await;
            return Err(e);
        }
    };
    drop(gate);
    let r = async {
        if out.cancelled() {
            teardown_visible(d).await;
            return Err("cancelled by client; the session was not changed".into());
        }
        // a leftover c_user (expired/revoked session) must not count as "logged in": start signed out,
        // and before navigating, so the page the user sees is the login page rather than the old feed
        let _ = b.cdp.call(None, "Storage.clearCookies", json!({})).await;
        let ts = b.cdp.call(None, "Target.getTargets", json!({})).await?;
        if let Some(t) = ts["targetInfos"]
            .as_array()
            .and_then(|a| a.iter().find(|t| t["type"] == "page"))
        {
            let id = t["targetId"].as_str().unwrap_or_default();
            let _ = b
                .cdp
                .call(None, "Target.activateTarget", json!({"targetId":id}))
                .await;
            if let Ok(a) = b
                .cdp
                .call(
                    None,
                    "Target.attachToTarget",
                    json!({"targetId":id,"flatten":true}),
                )
                .await
            {
                let s = a["sessionId"].as_str().unwrap_or_default().to_string();
                let _ = b
                    .cdp
                    .call(
                        Some(&s),
                        "Page.navigate",
                        json!({"url":"https://www.facebook.com/"}),
                    )
                    .await;
            }
        }
        if out.cancelled() {
            teardown_visible(d).await;
            return Err("cancelled by client; the session was not changed".into());
        }
        out.err("fb: log in to Facebook in the Chrome window that just opened\n");
        let deadline = Instant::now() + Duration::from_secs(900); // under the 1200s command limit
        while Instant::now() < deadline {
            if out.cancelled() {
                teardown_visible(d).await; // never leave a login window (and the lock) behind
                return Err("cancelled by client".into());
            }
            if b.cdp.closed.load(std::sync::atomic::Ordering::SeqCst) {
                return Err("lost the connection to Chrome; run `fb login --visible` again".into());
            }
            // bounded: a Chrome that stops answering must not hold the login (and its lock) forever
            if tokio::time::timeout(Duration::from_secs(5), logged_in(&b.cdp))
                .await
                .unwrap_or(false)
            {
                tokio::time::sleep(Duration::from_secs(3)).await;
                d.drop_browser(true).await;
                d.reset_account_caches().await;
                out.line("logged in");
                return Ok(());
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
        // never leave the visible browser behind: later commands would reuse it and open windows
        teardown_visible(d).await;
        Err("login timeout".into())
    }
    .await;
    if r.is_err() {
        // any failure (relay drop, timeout, cancellation): never leave a visible browser behind
        teardown_visible(d).await;
    }
    r
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_facebook_and_messenger_cookies_are_copied() {
        let yes = |d: &str| is_fb_cookie(&json!({"domain": d}));
        assert!(
            yes(".facebook.com")
                && yes("facebook.com")
                && yes("www.facebook.com")
                && yes(".messenger.com")
        );
        assert!(
            !yes(".google.com") && !yes("notfacebook.com") && !yes("facebook.com.evil.example")
        );
    }

    #[test]
    fn login_needs_the_facebook_c_user_cookie() {
        let c = |n: &str, d: &str| json!({"name": n, "domain": d});
        assert!(has_login(&[
            c("xs", ".facebook.com"),
            c("c_user", ".facebook.com")
        ]));
        assert!(!has_login(&[
            c("c_user", ".messenger.com"),
            c("xs", ".facebook.com")
        ]));
        assert!(!has_login(&[c("c_user", "facebook.com.evil.example")]));
        assert!(!has_login(&[c("c_user", "notfacebook.com")]));
        assert!(!has_login(&[]));
    }

    #[test]
    fn cookie_params_keep_security_flags_and_drop_extras() {
        let p = cookie_param(
            &json!({"name":"xs","value":"v","domain":".facebook.com","path":"/","secure":true,"httpOnly":true,"sameSite":"None","expires":1900000000.5,"size":9,"session":false,"sourcePort":443}),
        );
        assert_eq!(p["httpOnly"], true);
        assert_eq!(p["expires"], 1900000000.5);
        assert!(p.get("size").is_none() && p.get("sourcePort").is_none());
        let s = cookie_param(&json!({"name":"s","value":"v","domain":"a","path":"/","expires":-1}));
        assert!(s.get("expires").is_none());
    }
}
