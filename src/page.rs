use crate::browser::{Browser, Tab};
use crate::cdp::Res;
use crate::daemon::{Daemon, Out};
use serde_json::json;
use std::collections::HashMap;
use std::sync::{Arc, atomic::Ordering};
use tokio::sync::Mutex;

fn reject_symlink(path: &std::path::Path) -> Res<()> {
    match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => Err("recording destination is a symlink".into()),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

pub(crate) struct RecordingFile {
    temp: std::path::PathBuf,
    destination: std::path::PathBuf,
    handle: Option<std::fs::File>,
    committed: bool,
}

impl RecordingFile {
pub(crate) fn create(file: &str) -> Res<Self> {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let path = std::path::Path::new(file);
    reject_symlink(path)?;
    let parent = path.parent().ok_or("recording needs a destination directory")?;
    let (temp, handle) = loop {
        let id = NEXT.fetch_add(1, Ordering::Relaxed);
        let temp = parent.join(format!(".fb-record-{}-{id}.tmp", std::process::id()));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
        match options.open(&temp) {
            Ok(handle) => break (temp, handle),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.to_string()),
        }
    };
    Ok(Self { temp, destination: path.to_owned(), handle: Some(handle), committed: false })
}

pub(crate) fn write(&mut self, bytes: &[u8]) -> Res<()> {
    use std::io::Write;
    self.handle.as_mut().unwrap().write_all(bytes).map_err(|e| e.to_string())
}

pub(crate) fn sync(&self) -> Res<()> {
    self.handle.as_ref().unwrap().sync_all().map_err(|e| e.to_string())
}

fn finish(mut self, out: &Out, story_guard: Option<&crate::stories::StoryGuard>) -> Res<()> {
    drop(self.handle.take());
    if out.cancelled() { return Err("cancelled; no recording written".into()); }
    reject_symlink(&self.destination)?;
    if out.cancelled() { return Err("cancelled; no recording written".into()); }
    if story_guard.is_some_and(|guard| guard.finished()) { return Err("story protection stopped; page closed".into()); }
    std::fs::rename(&self.temp, &self.destination).map_err(|e| e.to_string())?;
    self.committed = true;
    Ok(())
}

pub(crate) fn finish_new(mut self, check: impl FnOnce() -> Res<()>) -> Res<()> {
    drop(self.handle.take());
    check()?;
    std::fs::hard_link(&self.temp, &self.destination).map_err(|e| e.to_string())?;
    Ok(())
}
}

impl Drop for RecordingFile {
    fn drop(&mut self) {
        tokio::task::block_in_place(|| {
            drop(self.handle.take());
            if !self.committed { let _ = std::fs::remove_file(&self.temp); }
        });
    }
}

fn compact_story_snapshot(snapshot: &str) -> String {
    let mut lines = snapshot.lines();
    let mut out = lines.next().unwrap_or("").to_string();
    if let Some(text) = lines.next() {
        let mut chars = text.chars();
        out.push('\n');
        out.extend(chars.by_ref().take(325));
        if chars.next().is_some() { out.push('…'); }
    }
    for (i, line) in lines.enumerate() {
        if i == 30 { out.push_str("\nmore\tuse page snapshot [filter] for more controls"); break; }
        out.push('\n');
        out.push_str(line);
    }
    out
}

#[derive(Default)]
pub struct Pages(Mutex<HashMap<String, Arc<Mutex<Option<Page>>>>>);
struct Page {
    browser: Arc<Browser>,
    generation: u64,
    tab: Tab,
    story_guard: Option<crate::stories::StoryGuard>,
}

impl Pages {
    pub async fn clear(&self) {
        self.0.lock().await.clear();
    }
}

enum Action {
    Open(String),
    Stories(String),
    Snapshot(String),
    Click(String),
    Fill(String, String),
    Key(String, String, u32, u32),
    Scroll(i32, i32),
    Record(String, u32, Option<f64>, bool),
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
        ["stories"] => Action::Stories("https://www.facebook.com/".into()),
        ["stories", url] => {
            let path = crate::ops::fb_path(url).ok_or("stories needs a Facebook story URL")?;
            let pathname = path.split(['?', '#']).next().unwrap_or("");
            if !pathname.starts_with("/stories/") || pathname.split('/').any(crate::ops::is_dot_segment) {
                return Err("stories needs a Facebook story URL".into());
            }
            Action::Stories(format!("https://www.facebook.com{path}"))
        }
        ["snapshot"] => Action::Snapshot(String::new()),
        ["snapshot", filter] => Action::Snapshot(filter.to_string()),
        ["record", args @ ..] => {
            let (args, force) = if args.last() == Some(&"--force") { (&args[..args.len()-1], true) } else { (args, false) };
            let (file, seconds, offset) = match args {
                [file] => (*file, 15, None),
                [file, seconds] | [file, seconds, _] => {
                    let seconds = seconds.parse().ok().filter(|s| (1..=30).contains(s)).ok_or("record seconds must be 1-30")?;
                    let offset = args.get(2).map(|offset| offset.parse().ok().filter(|s: &f64| s.is_finite() && *s >= 0.0).ok_or("record offset must be nonnegative")).transpose()?;
                    (*file, seconds, offset)
                },
                _ => return Err("record needs file [seconds [offset]] [--force]".into()),
            };
            Action::Record(crate::proto::resolve_path(cwd, file), seconds, offset, force)
        }
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
        _ => return Err("page actions: open URL | stories [URL] | snapshot [filter] | click ref | fill ref text | key chord | scroll dx dy | record file [seconds [offset]] [--force] | upload ref files... | eval js | cdp method json | shot file | close".into()),
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
        if matches!(action, Action::Open(_) | Action::Stories(_)) && !pages.contains_key(&name) {
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
    let mut page = if matches!(action, Action::Open(_) | Action::Stories(_)) {
        state.take();
        Page {
            generation: browser.generation.load(Ordering::SeqCst),
            tab: if matches!(action, Action::Stories(_)) { browser.new_story_tab().await? } else { browser.new_tab(None).await? },
            browser: browser.clone(),
            story_guard: None,
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
    if matches!(action, Action::Stories(_)) {
        page.story_guard = Some(tokio::time::timeout(std::time::Duration::from_secs(10), crate::stories::protect(&browser, &page.tab))
            .await.map_err(|_| "protecting story session timed out")??);
        out.err("experimental: Facebook may still record a story view; live privacy has not been verified\n");
    } else if let Some(guard) = &page.story_guard {
        if guard.finished() {
            return Err("story protection stopped; page closed".into());
        }
        if matches!(action, Action::Eval(_) | Action::Cdp(_, _) | Action::Fill(_, _) | Action::Upload(_, _) | Action::Key(_, _, _, _)) {
            *state = Some(page);
            return Err("action unavailable on a protected story page".into());
        }
    }
    // The armed tab is local during execution: cancellation drops it instead of replaying a mutation.
    let mut input_started = false;
    let file_action = matches!(&action, Action::Record(..) | Action::Shot(_));
    let result = execute(&browser, &mut page.tab, action, out, &mut input_started, page.story_guard.as_ref()).await;
    if page.story_guard.as_ref().is_some_and(|guard| guard.finished()) {
        if file_action && result.is_ok() {
            out.err("story protection stopped; page closed\n");
            return result;
        }
        return Err("story protection stopped; page closed".into());
    }
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
    story_guard: Option<&crate::stories::StoryGuard>,
) -> Res<()> {
    let story_open = matches!(&action, Action::Stories(_));
    match action {
        Action::Open(url) | Action::Stories(url) => {
            b.goto(t, &url).await?;
            let value = b.eval(t, "window.__fb.pageSnapshot()").await?;
            let snapshot = value.as_str().unwrap_or("");
            if story_open { out.line(compact_story_snapshot(snapshot)); } else { out.line(snapshot); }
        }
        Action::Snapshot(filter) => out.line(
            b.eval(t, &format!("window.__fb.pageSnapshot({})", json!(filter)))
                .await?
                .as_str()
                .unwrap_or(""),
        ),
        Action::Record(file, seconds, offset, force) => {
            use base64::Engine;
            use futures_util::StreamExt;
            if !force { return Err("inspect the page with shot, then add --force to record its video".into()); }
            tokio::task::block_in_place(|| reject_symlink(std::path::Path::new(&file)))?;
            out.err("recording contains video and audio only; page captions and stickers require a screenshot\n");
            out.err("--force can record a hidden video; inspect the page screenshot first\n");
            let session = t.session.as_str();
            let expression = format!("({})({seconds},{})", include_str!("../js/story-record.js"), json!(offset));
            let result = b.cdp.call(Some(session), "Runtime.evaluate", json!({"expression":expression,"awaitPromise":true,"returnByValue":false})).await?;
            let object = crate::browser::evaluation_result(&result)?["objectId"].as_str().ok_or("recording data missing")?.to_owned();
            let staged: Res<RecordingFile> = async {
                if out.cancelled() { return Err("cancelled; no recording written".into()); }
                let size = b.cdp.call(Some(session), "Runtime.callFunctionOn", json!({"objectId":object,"functionDeclaration":"function(){return this.size}","returnByValue":true})).await?;
                let size = crate::browser::evaluation_result(&size)?["value"].as_u64().filter(|n| *n > 0 && *n <= 64 * 1024 * 1024).ok_or("invalid recording size")?;
                let path = file.clone();
                let mut output = tokio::task::spawn_blocking(move || RecordingFile::create(&path)).await.map_err(|e| e.to_string())??;
                const CHUNK: u64 = 1024 * 1024;
                let object = &object;
                let chunks = futures_util::stream::iter((0..size).step_by(CHUNK as usize).map(|start| async move {
                    if out.cancelled() { return Err("cancelled; no recording written".to_string()); }
                    let end = (start + CHUNK).min(size);
                    let chunk = b.cdp.call(Some(session), "Runtime.callFunctionOn", json!({"objectId":object,"functionDeclaration":"function(a,b){return new Promise((ok,bad)=>{const r=new FileReader();r.onerror=()=>bad(Error('could not read recording'));r.onload=()=>ok(r.result.split(',')[1]);r.readAsDataURL(this.slice(a,b,'application/octet-stream'))})}","arguments":[{"value":start},{"value":end}],"awaitPromise":true,"returnByValue":true})).await?;
                    let data = crate::browser::evaluation_result(&chunk)?["value"].as_str().ok_or("recording chunk missing")?;
                    let bytes = base64::engine::general_purpose::STANDARD.decode(data).map_err(|e| e.to_string())?;
                    if bytes.len() as u64 != end - start { return Err("recording chunk length mismatch".into()); }
                    Ok(bytes)
                })).buffered(4);
                tokio::pin!(chunks);
                while let Some(chunk) = chunks.next().await {
                    if out.cancelled() { return Err("cancelled; no recording written".into()); }
                    let chunk = chunk?;
                    output = tokio::task::spawn_blocking(move || { output.write(&chunk)?; Ok::<_, String>(output) }).await.map_err(|e| e.to_string())??;
                }
                Ok(output)
            }.await;
            let _ = tokio::time::timeout(std::time::Duration::from_secs(2), b.cdp.call(Some(session), "Runtime.releaseObject", json!({"objectId":object}))).await;
            let output = staged?;
            if story_guard.is_some_and(|guard| guard.finished()) { return Err("story protection stopped; page closed".into()); }
            let output = tokio::task::spawn_blocking(move || { output.sync()?; Ok::<_, String>(output) }).await.map_err(|e| e.to_string())??;
            if story_guard.is_some_and(|guard| guard.finished()) { return Err("story protection stopped; page closed".into()); }
            tokio::task::block_in_place(|| output.finish(out, story_guard))?;
            out.line(file);
        }
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
            if let Some(guard) = story_guard {
                if guard.finished() { return Err("story protection stopped; page closed".into()); }
                let path = file.clone();
                let output = tokio::task::spawn_blocking(move || {
                    let mut output = RecordingFile::create(&path)?;
                    output.write(&bytes)?;
                    Ok::<_, String>(output)
                }).await.map_err(|e| e.to_string())??;
                if guard.finished() { return Err("story protection stopped; page closed".into()); }
                tokio::task::block_in_place(|| output.finish(out, story_guard))?;
            } else {
                std::fs::write(&file, bytes).map_err(|e| e.to_string())?;
            }
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
