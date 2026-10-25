use crate::browser::{Browser, Tab};
use crate::cdp::Res;
use crate::daemon::{Daemon, Out};
use serde_json::json;
use std::collections::HashMap;
use std::sync::{Arc, atomic::Ordering};
use tokio::sync::Mutex;

#[derive(Default)]
pub struct Pages(Mutex<HashMap<String, Arc<Mutex<Option<Page>>>>>);
struct Page {
    browser: Arc<Browser>,
    generation: u64,
    tab: Tab,
}

impl Pages {
    pub async fn clear(&self) {
        self.0.lock().await.clear();
    }
}

enum Action {
    Open(String),
    Snapshot(String),
    Click(String),
    Fill(String, String),
    Key(String, String, u32, u32),
    Scroll(i32, i32),
    Upload(String, Vec<String>),
    Eval(String),
    Cdp(String, serde_json::Value),
    Shot(String),
    Close,
}

fn parse(args: &[String], cwd: &str) -> Res<(String, Action)> {
    let name = args.first().ok_or("usage: page <name> <action> [args]")?;
    if name.is_empty()
        || name.len() > 32
        || !name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err("page name: 1-32 letters, digits, - or _".into());
    }
    let rest: Vec<&str> = args.iter().skip(1).map(String::as_str).collect();
    let action = match rest.as_slice() {
        ["open", url] => {
            if !(url.starts_with("https://") || url.starts_with("http://")) || url.chars().any(char::is_control) {
                return Err("page open needs an http(s) URL".into());
            }
            Action::Open(url.to_string())
        }
        ["snapshot"] => Action::Snapshot(String::new()),
        ["snapshot", filter] => Action::Snapshot(filter.to_string()),
        ["click", target] => Action::Click(target.to_string()),
        ["fill", target, text] => Action::Fill(target.to_string(), text.to_string()),
        ["eval", js] => Action::Eval(js.to_string()),
        ["cdp", method, params] => {
            let params: serde_json::Value = serde_json::from_str(params).map_err(|e| format!("invalid CDP params: {e}"))?;
            if !params.is_object() { return Err("CDP params must be an object".into()); }
            Action::Cdp(method.to_string(), params)
        },
        ["shot", file] => Action::Shot(crate::proto::resolve_path(cwd, file)),
        ["scroll", x, y] => Action::Scroll(x.parse().map_err(|_| "scroll needs integer dx dy")?, y.parse().map_err(|_| "scroll needs integer dx dy")?),
        ["upload", target, files @ ..] if !files.is_empty() => {
            let files: Vec<_> = files.iter().map(|f| crate::proto::resolve_path(cwd, f)).collect();
            for file in &files {
                if !std::path::Path::new(file).is_file() { return Err(format!("not a file: {file}")); }
            }
            Action::Upload(target.to_string(), files)
        }
        ["key", chord] => {
            let mut parts: Vec<_> = chord.split('+').collect();
            let key = parts.pop().ok_or("key required")?;
            let mut modifiers = 0;
            for p in parts { modifiers |= match p.to_ascii_lowercase().as_str() {
                "alt" => 1, "ctrl" | "control" => 2, "meta" | "cmd" => 4, "shift" => 8,
                _ => return Err(format!("unknown key modifier: {p}")),
            }; }
            let (key, code, vk) = match key {
                "Enter" => ("Enter".into(), "Enter".into(), 13),
                "Tab" => ("Tab".into(), "Tab".into(), 9),
                "Escape" => ("Escape".into(), "Escape".into(), 27),
                "Backspace" => ("Backspace".into(), "Backspace".into(), 8),
                "Delete" => ("Delete".into(), "Delete".into(), 46),
                "ArrowLeft" => (key.into(), key.into(), 37), "ArrowUp" => (key.into(), key.into(), 38),
                "ArrowRight" => (key.into(), key.into(), 39), "ArrowDown" => (key.into(), key.into(), 40),
                "Home" => (key.into(), key.into(), 36), "End" => (key.into(), key.into(), 35),
                "Space" => (" ".into(), "Space".into(), 32),
                k if k.len() == 1 && k.is_ascii() => (k.into(), if k.as_bytes()[0].is_ascii_digit() { format!("Digit{k}") } else if k.as_bytes()[0].is_ascii_alphabetic() { format!("Key{}", k.to_ascii_uppercase()) } else { String::new() }, k.to_ascii_uppercase().as_bytes()[0] as u32),
                _ => return Err("unsupported key; use Enter, Tab, Escape, arrows, or modifier+a".into()),
            };
            Action::Key(key, code, vk, modifiers)
        }
        ["close"] => Action::Close,
        _ => return Err("page actions: open URL | snapshot [filter] | click ref | fill ref text | key chord | scroll dx dy | upload ref files... | eval js | cdp method json | shot file | close".into()),
    };
    Ok((name.clone(), action))
}

pub async fn run(d: &Daemon, args: &[String], cwd: &str, out: &Out) -> Res<()> {
    let (name, action) = parse(args, cwd)?;
    if matches!(action, Action::Close) {
        let slot = d
            .pages
            .0
            .lock()
            .await
            .remove(&name)
            .ok_or("page expired or unknown; nothing to close")?;
        if let Some(page) = slot.lock().await.take() {
            page.browser.close(page.tab).await;
        }
        out.line("closed");
        return Ok(());
    }
    let browser = d.browser(out).await?;
    if let Action::Key(_, code, _, modifiers) = &action {
        let mac = crate::browser::UA
            .get()
            .is_some_and(|ua| ua.contains("Macintosh"));
        crate::keys::commands(mac, code, *modifiers)?;
    }
    let _account = d.account.read().await;
    let slot = {
        let mut pages = d.pages.0.lock().await;
        if matches!(action, Action::Open(_)) && !pages.contains_key(&name) {
            if pages.len() >= 6 {
                return Err("six pages open; close one first".into());
            }
            pages.insert(name.clone(), Arc::new(Mutex::new(None)));
        }
        pages
            .get(&name)
            .cloned()
            .ok_or("page expired or unknown; use `page <name> open URL`")?
    };
    let mut state = slot.lock().await;
    // Removing a registry entry must invalidate callers already queued on its mutex.
    if !d
        .pages
        .0
        .lock()
        .await
        .get(&name)
        .is_some_and(|s| Arc::ptr_eq(s, &slot))
    {
        return Err("page expired; reopen explicitly".into());
    }
    let mut page = if matches!(action, Action::Open(_)) {
        state.take();
        Page {
            generation: browser.generation.load(Ordering::SeqCst),
            tab: browser.new_tab(None).await?,
            browser: browser.clone(),
        }
    } else {
        state.take().ok_or("page expired; reopen explicitly")?
    };
    if !Arc::ptr_eq(&page.browser, &browser)
        || page.generation != browser.generation.load(Ordering::SeqCst)
    {
        return Err("page expired after reconnect or account change; reopen explicitly".into());
    }
    if out.cancelled() {
        return Err("cancelled; page closed, inspect before retrying".into());
    }
    // The armed tab is local during execution: cancellation drops it instead of replaying a mutation.
    let mut input_started = false;
    let result = execute(&browser, &mut page.tab, action, out, &mut input_started).await;
    if !out.cancelled() && (result.is_ok() || !input_started) {
        *state = Some(page);
    }
    result
}

async fn execute(
    b: &Browser,
    t: &mut Tab,
    action: Action,
    out: &Out,
    input_started: &mut bool,
) -> Res<()> {
    match action {
        Action::Open(url) => {
            b.goto(t, &url).await?;
            out.line(
                b.eval(t, "window.__fb.pageSnapshot()")
                    .await?
                    .as_str()
                    .unwrap_or(""),
            );
        }
        Action::Snapshot(filter) => out.line(
            b.eval(t, &format!("window.__fb.pageSnapshot({})", json!(filter)))
                .await?
                .as_str()
                .unwrap_or(""),
        ),
        Action::Eval(js) => {
            *input_started = true;
            let value = b.eval(t, &js).await?;
            out.line(
                value
                    .as_str()
                    .map(String::from)
                    .unwrap_or_else(|| value.to_string()),
            );
        }
        Action::Cdp(method, params) => {
            *input_started = true;
            out.line(
                b.cdp
                    .call(Some(&t.session), &method, params)
                    .await?
                    .to_string(),
            );
        }
        Action::Shot(file) => {
            use base64::Engine;
            let r = b
                .cdp
                .call(
                    Some(&t.session),
                    "Page.captureScreenshot",
                    json!({"format":"jpeg","quality":75}),
                )
                .await?;
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(r["data"].as_str().unwrap_or(""))
                .map_err(|e| e.to_string())?;
            std::fs::write(&file, bytes).map_err(|e| e.to_string())?;
            out.line(file);
        }
        Action::Click(ref target) | Action::Fill(ref target, _) | Action::Upload(ref target, _) => {
            let kind = match &action {
                Action::Fill(..) => "fill",
                Action::Upload(..) => "upload",
                _ => "click",
            };
            let pos = b
                .eval(
                    t,
                    &format!(
                        "window.__fb.pageTarget({},{},false)",
                        json!(target),
                        json!(kind)
                    ),
                )
                .await?;
            let x = pos["x"].as_f64().ok_or("no target x")?;
            let y = pos["y"].as_f64().ok_or("no target y")?;
            if kind == "click" {
                b.hover(t, x, y).await?;
            }
            let current = b
                .eval(
                    t,
                    &format!(
                        "window.__fb.pageTarget({},{},true)",
                        json!(target),
                        json!(kind)
                    ),
                )
                .await?;
            if kind == "click"
                && (current["x"].as_f64() != Some(x) || current["y"].as_f64() != Some(y))
            {
                return Err("element moved during hover; take a new snapshot".into());
            }
            if out.cancelled() {
                return Err("cancelled; page closed, inspect before retrying".into());
            }
            *input_started = true;
            match action {
                Action::Fill(_, text) => b.insert_text(t, &text).await?,
                Action::Upload(_, files) => {
                    let r = b
                        .cdp
                        .call(
                            Some(&t.session),
                            "Runtime.evaluate",
                            json!({"expression":"window.__fbPageTarget"}),
                        )
                        .await?;
                    let object = r["result"]["objectId"]
                        .as_str()
                        .ok_or("file input vanished")?;
                    if out.cancelled() {
                        return Err("cancelled; page closed, inspect before retrying".into());
                    }
                    let set = b
                        .cdp
                        .call(
                            Some(&t.session),
                            "DOM.setFileInputFiles",
                            json!({"objectId":object,"files":files}),
                        )
                        .await;
                    let _ = b
                        .cdp
                        .call(
                            Some(&t.session),
                            "Runtime.releaseObject",
                            json!({"objectId":object}),
                        )
                        .await;
                    set?;
                }
                _ => {
                    b.mouse(t, "mousePressed", x, y, "left", 1).await?;
                    b.mouse(t, "mouseReleased", x, y, "left", 1).await?;
                }
            }
            out.line("ok");
        }
        Action::Key(key, code, vk, modifiers) => {
            *input_started = true;
            b.key(t, &key, &code, vk, modifiers).await?;
            out.line("ok");
        }
        Action::Scroll(x, y) => {
            b.eval(t, &format!("window.scrollBy({x},{y})")).await?;
            out.line("ok");
        }
        Action::Close => unreachable!(),
    }
    Ok(())
}
