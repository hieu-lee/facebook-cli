use crate::browser::{Browser, Tab};
use crate::cdp::Res;
use crate::daemon::{Daemon, Out};
use serde_json::{Value, json};
use std::time::{Duration, Instant};

#[derive(Clone, Debug)]
pub struct Chat {
    pub path: String,
    pub name: String,
    pub preview: String,
    pub time: String,
    pub unread: bool,
    pub group: bool,
}

impl Chat {
    fn e2ee(&self) -> bool {
        self.path.contains("/e2ee/")
    }
}

/// How many chats a name lookup scans.
const RESOLVE_DEPTH: usize = 5000;
/// How long a cached chat list may be used to resolve a chat name.
const RESOLVE_TTL: Duration = Duration::from_secs(600);

fn flags(c: &Chat) -> String {
    let mut f = String::new();
    if c.unread {
        f.push('!');
    }
    if c.group {
        f.push('g');
    }
    if c.e2ee() {
        f.push('e');
    }
    if f.is_empty() {
        f.push('-');
    }
    f
}

/// `complete`: the scan actually reached the end of the chat list (not just a time budget or a
/// stall that gave up partway). Only then may "fewer rows than asked for" be read as "that is everything".
async fn fetch_chats(b: &std::sync::Arc<Browser>, n: usize) -> Res<(Vec<Chat>, bool)> {
    let t = b.acquire_kind("messages").await?;
    let r = async {
        if t.kind != "messages" {
            b.goto(&t, "https://www.facebook.com/messages/t/").await?;
        }
        let v = b
            .eval(&t, &format!("window.__fb.chats({n}).then(JSON.stringify)"))
            .await?;
        let v: Value =
            serde_json::from_str(v.as_str().unwrap_or("{}")).map_err(|e| e.to_string())?;
        if let Some(e) = v["err"].as_str() {
            return Err(e.to_string());
        }
        let list = v["chats"]
            .as_array()
            .map(|a| {
                a.iter()
                    .map(|c| Chat {
                        path: c["href"].as_str().unwrap_or("").to_string(),
                        name: c["name"].as_str().unwrap_or("").to_string(),
                        preview: c["preview"].as_str().unwrap_or("").to_string(),
                        time: c["time"].as_str().unwrap_or("").to_string(),
                        unread: c["unread"] == Value::Bool(true),
                        group: c["group"] == Value::Bool(true),
                    })
                    .collect()
            })
            .unwrap_or_default();
        Ok((list, v["complete"] == Value::Bool(true)))
    }
    .await;
    b.release_as(t, if r.is_ok() { "messages" } else { "" })
        .await;
    r
}

/// Chat list snapshot kept in memory and on disk so name lookups do not need a page load.
pub struct ChatCache {
    /// Facebook user id the list belongs to: a cache is only valid for the account that made it
    uid: String,
    at: Instant,
    /// how many chats were requested when it was fetched
    n: usize,
    /// the scan reached the true end of the chat list (see `fetch_chats`)
    complete: bool,
    list: Vec<Chat>,
}

impl ChatCache {
    pub fn load(path: &std::path::Path) -> Option<ChatCache> {
        let text = std::fs::read_to_string(path).ok()?;
        let age = std::fs::metadata(path)
            .ok()?
            .modified()
            .ok()?
            .elapsed()
            .unwrap_or_default();
        let mut lines = text.lines();
        let uid = lines.next()?.strip_prefix("#uid=")?.to_string();
        let n = lines.next()?.strip_prefix("#n=")?.parse().ok()?;
        // older cache files predate this header: absence means "not proven complete" (safe default)
        let complete = lines.next()?.strip_prefix("#complete=")? == "1";
        let list = lines
            .filter_map(|l| {
                let f: Vec<&str> = l.split('\t').collect();
                (f.len() == 6).then(|| Chat {
                    path: f[0].into(),
                    name: f[1].into(),
                    time: f[2].into(),
                    unread: f[3] == "1",
                    group: f[4] == "1",
                    preview: f[5].into(),
                })
            })
            .collect();
        Some(ChatCache {
            uid,
            at: Instant::now().checked_sub(age).unwrap_or_else(Instant::now),
            n,
            complete,
            list,
        })
    }

    fn save(&self, path: &std::path::Path) {
        let mut s = format!(
            "#uid={}\n#n={}\n#complete={}\n",
            self.uid, self.n, self.complete as u8
        );
        for c in &self.list {
            let clean = |x: &str| x.replace(['\t', '\n'], " ");
            s.push_str(&format!(
                "{}\t{}\t{}\t{}\t{}\t{}\n",
                c.path,
                clean(&c.name),
                clean(&c.time),
                c.unread as u8,
                c.group as u8,
                clean(&c.preview)
            ));
        }
        let _ = std::fs::write(path, s);
    }
}

/// Chats, newest first, and whether the scan behind them reached the true end of the list. Uses
/// the cache when it is younger than `max_age` and either deep enough or proven complete.
async fn chat_list(
    d: &Daemon,
    b: &std::sync::Arc<Browser>,
    n: usize,
    max_age: Duration,
) -> Res<(Vec<Chat>, bool)> {
    let requested = Instant::now();
    let uid = crate::ops::uid(d, b).await?;
    let usable = |c: &ChatCache, extra_fresh: bool| {
        c.uid == uid
            && (c.at.elapsed() <= max_age || (extra_fresh && c.at >= requested))
            && (c.n >= n || c.complete)
    };
    if let Some(c) = d.chat_cache.lock().await.as_ref()
        && usable(c, false)
    {
        return Ok((c.list.clone(), c.complete));
    }
    // one scan at a time: concurrent lookups share the first one's result
    let _scan = d.chat_scan.lock().await;
    // a scan that finished while we waited is fresh enough even for "no cache" requests
    if let Some(c) = d.chat_cache.lock().await.as_ref()
        && usable(c, true)
    {
        return Ok((c.list.clone(), c.complete));
    }
    let generation = b.generation.load(std::sync::atomic::Ordering::SeqCst);
    let (list, complete) = fetch_chats(b, n).await?;
    if b.generation.load(std::sync::atomic::Ordering::SeqCst) != generation {
        return Err("the account changed while chats were being read; try again".into());
    }
    let cache = ChatCache {
        uid,
        at: Instant::now(),
        n,
        complete,
        list: list.clone(),
    };
    cache.save(&d.chats_file());
    *d.chat_cache.lock().await = Some(cache);
    Ok((list, complete))
}

/// One TSV field: tabs and newlines would split a record.
pub fn one_line(s: &str) -> String {
    let mut o = String::with_capacity(s.len());
    push_one_line(&mut o, s);
    o
}

/// `one_line`, appended to `out`.
pub fn push_one_line(out: &mut String, s: &str) {
    for (i, w) in s.split_whitespace().enumerate() {
        if i > 0 {
            out.push(' ');
        }
        out.push_str(w);
    }
}

pub fn trunc(s: &str, n: usize) -> String {
    if s.chars().count() > n {
        s.chars().take(n).collect::<String>() + "…"
    } else {
        s.to_string()
    }
}

pub async fn chats(d: &Daemon, args: &[String], out: &Out) -> Res<()> {
    let a = crate::ops::parse(args, &[], &["unread"])?;
    let n = a.n.unwrap_or(20);
    let only_unread = a.flag("unread");
    let q = (!a.pos.is_empty()).then(|| a.pos.join(" ").to_lowercase());
    let b = d.browser(out).await?;
    let want = if q.is_some() || only_unread {
        n.max(100)
    } else {
        n.max(30)
    };
    let (list, _complete) = chat_list(d, &b, want, Duration::ZERO).await?;
    let mut shown = 0;
    for c in list {
        if only_unread && !c.unread {
            continue;
        }
        if let Some(q) = &q
            && !c.name.to_lowercase().contains(q)
        {
            continue;
        }
        if shown >= n {
            break;
        }
        shown += 1;
        out.line(format!(
            "{}\t{}\t{}\t{}\t{}",
            d.refs.put('c', &c.path),
            flags(&c),
            one_line(&c.time),
            one_line(&c.name),
            trunc(&one_line(&c.preview), 80)
        ));
    }
    Ok(())
}

/// `/messages/t/<id>` or `/messages/e2ee/t/<id>`: a specific conversation (not the inbox).
fn is_thread_path(p: &str) -> bool {
    // the pathname alone must name the thread: `/messages/t/?ref=x` is the inbox
    let path = p.split(['?', '#']).next().unwrap_or("");
    if path.contains('\\') || path.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return false;
    }
    let rest = path
        .strip_prefix("/messages/e2ee/t/")
        .or_else(|| path.strip_prefix("/messages/t/"));
    rest.is_some_and(|r| {
        let id = r.trim_matches('/');
        !id.is_empty() && !id.contains('/') && !crate::ops::is_dot_segment(id)
    })
}

/// profile path (/vanity or /profile.php?id=N) -> messenger thread path
fn thread_of_profile(p: &str) -> String {
    if p.starts_with("/messages/") {
        return p.to_string();
    }
    if let Some(id) = p.strip_prefix("/profile.php?id=") {
        return format!("/messages/t/{}/", id.split('&').next().unwrap_or(id));
    }
    // /people/Name-Slug/61512345678901/ -> the numeric id
    if let Some(rest) = p.strip_prefix("/people/")
        && let Some(id) = rest.trim_matches('/').rsplit('/').next()
        && !id.is_empty()
        && id.bytes().all(|c| c.is_ascii_digit())
    {
        return format!("/messages/t/{id}/");
    }
    format!("/messages/t/{}/", p.trim_matches('/'))
}

/// Messages go to people: a substring match may be the wrong chat (the chat list loads lazily, so
/// the exact name might not have been seen yet). Sending/removing needs an exact name, a ref, an id,
/// @person, or an explicit --fuzzy.
fn require_exact(d: &Daemon, t: &Resolved, spec: &str, fuzzy: bool) -> Res<()> {
    if t.exact || fuzzy {
        return Ok(());
    }
    Err(format!(
        "'{spec}' only partially matches '{}': use its ref ({}) or the exact name, or add --fuzzy",
        t.name.clone().unwrap_or_default(),
        d.refs.put('c', &t.path)
    ))
}

/// A resolved chat. `name` is set when it was found by name; `exact` is false for a substring match.
pub struct Resolved {
    pub path: String,
    pub name: Option<String>,
    pub exact: bool,
}

impl Resolved {
    fn path(path: String) -> Res<Resolved> {
        Ok(Resolved {
            path,
            name: None,
            exact: true,
        })
    }
}

pub async fn resolve(d: &Daemon, b: &std::sync::Arc<Browser>, spec: &str) -> Res<Resolved> {
    if let Some(p) = d.refs.get(spec) {
        return Resolved::path(thread_of_profile(&p));
    }
    if let Some(who) = spec.strip_prefix('@') {
        let path = thread_of_profile(&crate::ops::profile_path(d, b, who).await?);
        // `@.`/`@..` would normalize to the inbox: only a real thread path is a target
        if !is_thread_path(&path) {
            return Err(format!("not a valid person: @{who}"));
        }
        // `@vanity` / `@id` name exactly one account; `@First Last` is just the first search hit
        let direct = !who.is_empty()
            && who
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'.' || c == b'-');
        return Ok(Resolved {
            path,
            name: Some(format!("@{who}")),
            exact: direct,
        });
    }
    if spec.starts_with('/') || spec.starts_with("http") {
        let p = crate::ops::fb_path(spec).ok_or_else(|| format!("not a facebook url: {spec}"))?;
        // a profile or post page also has a comment box: never type a message into one
        if !is_thread_path(&p) {
            return Err(format!(
                "not a Messenger thread: {spec} (use a chat name, ref, id or @person)"
            ));
        }
        // navigate to the bare thread path (a query could change what opens)
        let bare = p.split(['?', '#']).next().unwrap_or("").to_string();
        return Resolved::path(bare);
    }
    if !spec.is_empty() && spec.bytes().all(|c| c.is_ascii_digit()) {
        return Resolved::path(format!("/messages/t/{spec}/"));
    }
    let q = spec.to_lowercase();
    // `trustworthy`: the scan proved it reached the true end of the list, so a unique exact match
    // cannot be hiding a duplicate further down that was never seen (a capped scan proves nothing).
    // Returns None when there is exactly one exact match but that could not be confirmed unique.
    let find = |list: &[Chat], trustworthy: bool| -> Option<(Vec<Chat>, bool)> {
        let exact: Vec<Chat> = list
            .iter()
            .filter(|c| c.name.to_lowercase() == q)
            .cloned()
            .collect();
        if exact.len() == 1 {
            return if trustworthy {
                Some((exact, true))
            } else {
                None
            };
        }
        Some((
            list.iter()
                .filter(|c| c.name.to_lowercase().contains(&q))
                .cloned()
                .collect(),
            false,
        ))
    };
    // the deep list: an exact name may sit below a partial match ("Alice Work" vs "Alice")
    let (list1, complete1) = chat_list(d, b, RESOLVE_DEPTH, RESOLVE_TTL).await?;
    let trustworthy1 = complete1;
    let mut found = find(&list1, trustworthy1);
    if matches!(&found, Some((hits, _)) if hits.is_empty()) || found.is_none() {
        let (list2, complete2) = chat_list(d, b, RESOLVE_DEPTH, Duration::ZERO).await?;
        let trustworthy2 = complete2;
        found = find(&list2, trustworthy2);
    }
    // never guess at uniqueness: fail closed instead of risking the wrong recipient
    let (hits, exact) = found.ok_or_else(|| {
        format!("could not finish scanning your chat list to confirm '{spec}' is unique; try again, or use a ref/id")
    })?;
    match hits.len() {
        0 => Err(format!("no chat matches '{spec}' (try `fb chats`)")),
        1 => Ok(Resolved {
            path: hits[0].path.clone(),
            name: Some(hits[0].name.clone()),
            exact,
        }),
        _ => Err(format!(
            "ambiguous '{spec}': {}",
            hits.iter()
                .take(6)
                .map(|c| format!("{} ({})", c.name, d.refs.put('c', &c.path)))
                .collect::<Vec<_>>()
                .join(", ")
        )),
    }
}

async fn open_thread(b: &std::sync::Arc<Browser>, t: &Tab, path: &str) -> Res<()> {
    if t.kind == "messages"
        && b.eval(t, &format!("window.__fb.spaOpen({})", json!(path)))
            .await?
            == Value::Bool(true)
    {
        return Ok(());
    }
    b.goto(t, &format!("https://www.facebook.com{path}"))
        .await?;
    let ok = b.eval(t, "window.__fb.threadReady()").await?;
    if ok != Value::Bool(true) {
        return Err("thread did not load (e2ee chat locked? run `fb unlock`)".into());
    }
    // never type into a conversation we did not ask for (numeric ids only: vanity urls redirect)
    let want = path.trim_matches('/').rsplit('/').next().unwrap_or("");
    if !want.is_empty() && want.bytes().all(|c| c.is_ascii_digit()) {
        let at = b.eval(t, "location.pathname").await?;
        let at = at.as_str().unwrap_or("").trim_matches('/');
        if at.rsplit('/').next() != Some(want) {
            return Err(format!(
                "opened a different conversation than requested ({at})"
            ));
        }
    }
    Ok(())
}

pub async fn read(d: &Daemon, args: &[String], out: &Out) -> Res<()> {
    let a = crate::ops::parse(args, &[], &[])?;
    let n = a.n.unwrap_or(20);
    let spec = a.pos.join(" ");
    if spec.is_empty() {
        return Err("usage: read <chat> [-n N]".into());
    }
    let spec = spec.as_str();
    let b = d.browser(out).await?;
    let gen0 = b.generation.load(std::sync::atomic::Ordering::SeqCst);
    let target = resolve(d, &b, spec).await?;
    let path = target.path.clone();
    let t = b.acquire_kind("messages").await?;
    if b.generation.load(std::sync::atomic::Ordering::SeqCst) != gen0 {
        return Err(
            "the account changed while this command waited; nothing was done, try again".into(),
        );
    }
    let r = async {
        open_thread(&b, &t, &path).await?;
        let v = b
            .eval(&t, &format!("window.__fb.read({n}).then(JSON.stringify)"))
            .await?;
        let v: Value =
            serde_json::from_str(v.as_str().unwrap_or("{}")).map_err(|e| e.to_string())?;
        if let Some(e) = v["err"].as_str() {
            return Err(e.to_string());
        }
        for m in v["msgs"].as_array().cloned().unwrap_or_default() {
            if let Some(dt) = m["d"].as_str() {
                out.line(format!("# {dt}"));
                continue;
            }
            let mut text = m["text"].as_str().unwrap_or("").replace('\n', " ⏎ ");
            let att = m["att"].as_str().unwrap_or("");
            if !att.is_empty() {
                text = format!("[{att}] {text}").trim_end().to_string();
            }
            let re = m["re"].as_str().unwrap_or("");
            if !re.is_empty() {
                text.push_str(&format!(" {{{re}}}"));
            }
            out.line(format!(
                "{} {}: {}",
                m["t"].as_str().unwrap_or(""),
                m["from"].as_str().unwrap_or("?"),
                text
            ));
        }
        Ok(())
    }
    .await;
    b.release_as(t, if r.is_ok() { "messages" } else { "" })
        .await;
    r
}

/// Insert the whole draft in one browser operation; no per-line focus races or round trips.
async fn type_text(b: &std::sync::Arc<Browser>, t: &Tab, text: &str) -> Res<()> {
    if b.eval(t, "window.__fb.focusComposer()").await? != Value::Bool(true) {
        return Err("no composer".into());
    }
    b.insert_text(t, text).await
}

/// Press Enter on what the composer holds and wait until our own new message shows up: `text`
/// verbatim, or (with `file`) a message carrying that attachment.
async fn submit(
    b: &std::sync::Arc<Browser>,
    t: &Tab,
    gen0: u64,
    out: &Out,
    text: &str,
    file: Option<&str>,
    wait_secs: u64,
) -> Res<()> {
    use std::sync::atomic::Ordering::SeqCst;
    if b.eval(t, "window.__fb.focusComposer()").await? != Value::Bool(true) {
        return Err("no composer".into());
    }
    if b.eval(t, "window.__fb.markSent()").await? != Value::Bool(true) {
        return Err("could not read the conversation; nothing more was sent".into());
    }
    // Marking may await history while a delayed restore modal steals focus.
    if b.eval(t, "window.__fb.focusComposer()").await? != Value::Bool(true) {
        return Err("no composer; nothing was sent".into());
    }
    if file.is_none()
        && b.eval(t, &format!("window.__fb.composerMatches({})", json!(text)))
            .await?
            != Value::Bool(true)
    {
        return Err(
            "draft changed; no text was sent; inspect the conversation before retrying".into(),
        );
    }
    if b.generation.load(SeqCst) != gen0 {
        return Err("the account changed while sending; nothing more was sent".into());
    }
    if out.cancelled() {
        return Err("cancelled by client; nothing more was sent".into());
    }
    b.key(t, "Enter", "Enter", 13, 0).await?;
    let mut pressed = Instant::now();
    let deadline = pressed + Duration::from_secs(wait_secs);
    let loose = file.is_some_and(|f| {
        let m = mime_of(f);
        m.starts_with("image/") || m.starts_with("video/")
    });
    let js = format!(
        "window.__fb.sentSince({},{},{})",
        json!(text),
        json!(file),
        loose
    );
    // our own outgoing message: an incoming one must not count as success
    while b.eval(t, &js).await? != Value::Bool(true) {
        if Instant::now() > deadline {
            return Err("not confirmed: the message did not show up as sent (timeout); check with `read` before retrying".into());
        }
        if out.cancelled() {
            return Err(
                "cancelled by client; check with `read` whether the last message went out".into(),
            );
        }
        // an attachment still sitting in the composer was never sent (Enter is ignored while it uploads)
        if let Some(f) = file
            && !out.cancelled()
            && pressed.elapsed() > Duration::from_secs(6)
            && b.eval(t, &format!("window.__fb.pendingFile({})", json!(f)))
                .await?
                == Value::Bool(true)
            // the client may have gone while that call was in flight
            && !out.cancelled()
        {
            b.key(t, "Enter", "Enter", 13, 0).await?;
            pressed = Instant::now();
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Ok(())
}

pub async fn send(d: &Daemon, args: &[String], cwd: &str, out: &Out) -> Res<()> {
    let a = crate::ops::parse(args, &["file", "img"], &["dry", "fuzzy"])?;
    let dry = a.flag("dry");
    // `--img` is the older name of `--file`; both attach any file, in the order given. Only the
    // metadata is checked here; each file is read when its turn comes (memory stays bounded).
    let mut files: Vec<(String, String)> = Vec::new();
    for (_, p) in a.opts.iter().filter(|(k, _)| k == "file" || k == "img") {
        let path = crate::proto::resolve_path(cwd, p);
        files.push((check_attachment(&path)?, path));
    }
    let (spec, text) = match a.pos.split_first() {
        Some((s, t)) => (s.as_str(), t.join(" ")),
        None => return Err("usage: send <chat> <text> [--file path]...".into()),
    };
    if text.trim().is_empty() && files.is_empty() {
        return Err("nothing to send".into());
    }
    let b = d.browser(out).await?;
    let gen0 = b.generation.load(std::sync::atomic::Ordering::SeqCst);
    // mutations hold the shared side of the account lock; an account import takes the exclusive side
    let _account = d.account.read().await;
    if b.generation.load(std::sync::atomic::Ordering::SeqCst) != gen0 {
        return Err(
            "the account changed while this command waited; nothing was done, try again".into(),
        );
    }
    let target = resolve(d, &b, spec).await?;
    require_exact(d, &target, spec, a.flag("fuzzy"))?;
    let path = target.path.clone();
    let t = b.acquire_kind("messages").await?;
    if b.generation.load(std::sync::atomic::Ordering::SeqCst) != gen0 {
        return Err(
            "the account changed while this command waited; nothing was done, try again".into(),
        );
    }
    let r = async {
        open_thread(&b, &t, &path).await?;
        if dry {
            for (name, path) in &files {
                attach(&b, &t, name, &read_attachment(path)?).await?;
            }
            if !text.is_empty() {
                type_text(&b, &t, &text).await?;
            }
            let v = b.eval(&t, "window.__fb.draft()").await?;
            out.line(format!("dry: {}", v.as_str().unwrap_or("")));
            b.eval(&t, "window.__fb.clearDraft()").await?;
            return Ok(());
        }
        // One message per file, then the text: every step must show up as exactly its own new outgoing
        // message, so a missing attachment can never be confirmed by another message.
        for (k, (name, path)) in files.iter().enumerate() {
            let step = async {
                attach(&b, &t, name, &read_attachment(path)?).await?;
                submit(&b, &t, gen0, out, "", Some(name), 120).await?;
                // reported as it happens: a later failure or timeout must not hide what already went out
                out.line(format!("sent file\t{}", one_line(name)));
                Ok::<(), String>(())
            };
            step.await
                .map_err(|e| format!(
                    "{e} ({k} of {} files confirmed sent; this file may or may not have gone out: check with `read` before retrying)",
                    files.len()
                ))?;
        }
        if !text.trim().is_empty() {
            let step = async {
                type_text(&b, &t, &text).await?;
                submit(&b, &t, gen0, out, &text, None, 20).await
            };
            step.await.map_err(|e| {
                if files.is_empty() {
                    e
                } else {
                    format!("{e} (the files were already sent)")
                }
            })?;
        }
        match &target.name {
            Some(n) => out.line(format!("sent\t{n}")),
            None => out.line("sent"),
        }
        if !target.exact {
            out.err("note: matched by partial name; use a ref or the exact name to be sure\n");
        }
        Ok(())
    }
    .await;
    // a tab that may hold a draft (dry run, failed send) is discarded, never reused for the next send
    if r.is_ok() && !dry {
        b.release_as(t, "messages").await;
    } else {
        b.close(t).await;
    }
    r
}

/// Messenger refuses larger attachments.
const MAX_ATTACHMENT: usize = 25 * 1024 * 1024;
/// Base64 chunk size sent per CDP call (a multiple of 4: every chunk decodes on its own).
const CHUNK: usize = 3 * 1024 * 1024;

fn mime_of(name: &str) -> &'static str {
    match name
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "heic" => "image/heic",
        "mp4" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "m4a" => "audio/mp4",
        "pdf" => "application/pdf",
        "zip" => "application/zip",
        "json" => "application/json",
        "txt" | "log" | "md" => "text/plain",
        "csv" => "text/csv",
        "doc" => "application/msword",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xls" => "application/vnd.ms-excel",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "ppt" => "application/vnd.ms-powerpoint",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        _ => "application/octet-stream",
    }
}

/// A name made only of blanks / zero-width characters could never be found again to confirm the send.
fn has_visible_char(name: &str) -> bool {
    name.chars().any(|c| {
        !c.is_whitespace()
            && !c.is_control()
            && !matches!(
                c,
                '\u{034f}' | '\u{200b}'..='\u{200f}' | '\u{2060}'..='\u{2064}' | '\u{feff}'
            )
    })
}

/// Cheap checks before any browser work starts; returns the file name Messenger will show.
fn check_attachment(path: &str) -> Res<String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("{path}: {e}"))?;
    if !meta.is_file() {
        return Err(format!("{path}: not a file"));
    }
    if meta.len() == 0 {
        return Err(format!("{path}: empty file"));
    }
    if meta.len() > MAX_ATTACHMENT as u64 {
        return Err(format!("{path}: larger than Messenger's 25MB limit"));
    }
    std::path::Path::new(path)
        .file_name()
        .and_then(|n| n.to_str())
        .filter(|n| has_visible_char(n))
        .map(String::from)
        .ok_or_else(|| format!("{path}: unusable file name"))
}

/// The bytes, read through one bounded handle: a file that grew or vanished since the check is refused.
fn read_attachment(path: &str) -> Res<Vec<u8>> {
    use std::io::Read;
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .and_then(|f| f.take(MAX_ATTACHMENT as u64 + 1).read_to_end(&mut bytes))
        .map_err(|e| format!("{path}: {e}"))?;
    if bytes.is_empty() || bytes.len() > MAX_ATTACHMENT {
        return Err(format!(
            "{path}: empty or larger than Messenger's 25MB limit"
        ));
    }
    Ok(bytes)
}

async fn attach(b: &std::sync::Arc<Browser>, t: &Tab, name: &str, bytes: &[u8]) -> Res<()> {
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
    b.eval(t, "window.__fb.upBegin()").await?;
    for chunk in b64.as_bytes().chunks(CHUNK) {
        // base64 is ASCII: the chunk is valid UTF-8 and needs no escaping beyond the JSON string
        let piece = std::str::from_utf8(chunk).unwrap_or_default();
        b.eval(t, &format!("window.__fb.upChunk({})", json!(piece)))
            .await?;
    }
    let js = format!(
        "window.__fb.attach({},{})",
        json!(name),
        json!(mime_of(name))
    );
    let r = b.eval(t, &js).await?;
    if r != Value::Bool(true) {
        return Err(format!("attach {name} failed: {r}"));
    }
    Ok(())
}

pub async fn unlock(d: &Daemon, args: &[String], out: &Out) -> Res<()> {
    let pin = args
        .first()
        .ok_or("usage: echo PIN | fb unlock -   (or FB_PIN=... fb unlock)")?;
    if pin.is_empty() || !pin.bytes().all(|c| c.is_ascii_digit()) {
        return Err("PIN must be digits".into());
    }
    let b = d.browser(out).await?;
    let t = b.acquire().await?;
    let r = async {
        b.goto(&t, "https://www.facebook.com/messages/t/").await?;
        match b.eval(&t, "window.__fb.pinFocus()").await? {
            Value::Bool(true) => {}
            Value::String(s) => return Err(s),
            _ => return Err("unexpected".into()),
        }
        b.insert_text(&t, pin).await?;
        match b.eval(&t, "window.__fb.pinDone()").await? {
            Value::Bool(true) => {}
            Value::String(s) => return Err(s),
            _ => return Err("unexpected".into()),
        }
        out.line("unlocked (history restores in the background)");
        Ok(())
    }
    .await;
    b.release(t).await;
    r
}

/// Remove (for everyone) your most recent message in a chat, optionally the latest one containing `--match`.
pub async fn unsend(d: &Daemon, args: &[String], out: &Out) -> Res<()> {
    let a = crate::ops::parse(args, &["match"], &["dry", "fuzzy"])?;
    let spec = a.pos.join(" ");
    if spec.is_empty() {
        return Err("usage: unsend <chat> [--match text] [--dry]".into());
    }
    let b = d.browser(out).await?;
    let gen0 = b.generation.load(std::sync::atomic::Ordering::SeqCst);
    // mutations hold the shared side of the account lock; an account import takes the exclusive side
    let _account = d.account.read().await;
    if b.generation.load(std::sync::atomic::Ordering::SeqCst) != gen0 {
        return Err(
            "the account changed while this command waited; nothing was done, try again".into(),
        );
    }
    let target = resolve(d, &b, &spec).await?;
    require_exact(d, &target, &spec, a.flag("fuzzy"))?;
    let t = b.acquire_kind("messages").await?;
    if b.generation.load(std::sync::atomic::Ordering::SeqCst) != gen0 {
        return Err(
            "the account changed while this command waited; nothing was done, try again".into(),
        );
    }
    let r = async {
        open_thread(&b, &t, &target.path).await?;
        let m = a.opt("match").unwrap_or("");
        let info = b
            .eval(&t, &format!("window.__fb.unsendOpen({})", json!(m)))
            .await?;
        let text = match &info {
            Value::String(e) => return Err(e.clone()),
            v => v["text"].as_str().unwrap_or("").to_string(),
        };
        if a.flag("dry") {
            out.line(format!("dry: would unsend\t{}", one_line(&text)));
            return Ok(false); // discard the tab: it has a dialog open
        }
        // last chance to stop: the confirm click cannot be undone
        if b.generation.load(std::sync::atomic::Ordering::SeqCst) != gen0 {
            return Err("the account changed meanwhile; nothing was removed".into());
        }
        if out.cancelled() {
            return Err("cancelled by client; nothing was removed".into());
        }
        match b.eval(&t, "window.__fb.unsendConfirm()").await? {
            Value::Bool(true) => {}
            Value::String(e) => return Err(e),
            other => return Err(format!("unexpected: {other}")),
        }
        out.line(format!("unsent\t{}", one_line(&text)));
        Ok(true)
    }
    .await;
    // the page may be left mid-dialog on failure or dry run: never reuse it
    if matches!(r, Ok(true)) {
        b.release_as(t, "messages").await;
    } else {
        b.close(t).await;
    }
    r.map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attachments_are_validated_before_any_browser_work() {
        let dir = std::env::temp_dir().join(format!("fb-att-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = |n: &str| dir.join(n).to_string_lossy().into_owned();
        std::fs::write(p("a.pdf"), b"%PDF").unwrap();
        std::fs::write(p("empty.txt"), b"").unwrap();
        assert_eq!(check_attachment(&p("a.pdf")).unwrap(), "a.pdf");
        assert_eq!(read_attachment(&p("a.pdf")).unwrap(), b"%PDF");
        assert!(
            check_attachment(&p("empty.txt"))
                .unwrap_err()
                .contains("empty")
        );
        assert!(read_attachment(&p("empty.txt")).is_err());
        assert!(check_attachment(&p("missing.bin")).is_err());
        assert!(read_attachment(&p("missing.bin")).is_err());
        assert!(
            check_attachment(&dir.to_string_lossy())
                .unwrap_err()
                .contains("not a file")
        );
        std::fs::remove_dir_all(&dir).unwrap();
        assert!(
            has_visible_char("\u{1f4ce}")
                && has_visible_char("a b")
                && has_visible_char("\u{20ac}")
        );
        assert!(
            !has_visible_char("   ")
                && !has_visible_char("\u{200b}\u{feff}")
                && !has_visible_char("")
        );
        assert_eq!(mime_of("Photo.JPG"), "image/jpeg");
        assert_eq!(mime_of("data.xyz"), "application/octet-stream");
        assert_eq!(mime_of("noext"), "application/octet-stream");
        assert_eq!(CHUNK % 4, 0);
    }

    #[test]
    fn only_specific_threads_are_valid_targets() {
        assert!(is_thread_path("/messages/t/123/"));
        assert!(is_thread_path("/messages/e2ee/t/9"));
        assert!(is_thread_path("/messages/t/some.vanity"));
        assert!(!is_thread_path("/messages/t/"));
        assert!(!is_thread_path("/messages/t/?ref=chat"));
        assert!(!is_thread_path("/messages/t/?folder=inbox"));
        assert!(!is_thread_path("/messages/t/../"));
        assert!(!is_thread_path("/messages/t/%2e%2e/"));
        assert!(!is_thread_path("/messages/t/1/2"));
        assert!(!is_thread_path("/messages/t/111\\..\\222"));
        assert!(!is_thread_path("/messages/t/1\t/2"));
        assert!(!is_thread_path(&thread_of_profile("/.")));
        assert!(!is_thread_path(&thread_of_profile("/..")));
        assert!(is_thread_path("/messages/t/123/?ref=x"));
        assert!(!is_thread_path("/messages/"));
        assert!(!is_thread_path("/messages/e2ee/t/"));
        assert!(!is_thread_path("/profile.php?id=1"));
    }

    #[test]
    fn thread_paths_from_profiles() {
        assert_eq!(
            thread_of_profile("/profile.php?id=123&sk=friends"),
            "/messages/t/123/"
        );
        assert_eq!(
            thread_of_profile("/some.vanity"),
            "/messages/t/some.vanity/"
        );
        assert_eq!(
            thread_of_profile("/messages/e2ee/t/9/"),
            "/messages/e2ee/t/9/"
        );
    }

    #[test]
    fn one_line_collapses_separators() {
        assert_eq!(
            one_line("first line\nsecond\tline  x"),
            "first line second line x"
        );
    }

    #[test]
    fn trunc_counts_chars_not_bytes() {
        assert_eq!(trunc("héllo wörld", 5), "héllo…");
        assert_eq!(trunc("short", 10), "short");
    }

    #[test]
    fn flags_encode_chat_kind() {
        let c = |path: &str, unread, group| Chat {
            path: path.into(),
            name: String::new(),
            preview: String::new(),
            time: String::new(),
            unread,
            group,
        };
        assert_eq!(flags(&c("/messages/t/1/", false, false)), "-");
        assert_eq!(flags(&c("/messages/e2ee/t/1/", true, false)), "!e");
        assert_eq!(flags(&c("/messages/t/1/", false, true)), "g");
    }
}
