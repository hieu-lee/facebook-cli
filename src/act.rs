use crate::browser::{Browser, Tab};
use crate::cdp::Res;
use crate::daemon::{Daemon, Out};
use crate::ops::{parse, resolve_post_strict};
use serde_json::{Value, json};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Mutations must run as the account they were started for (a `login` may swap it while we queue).
fn same_account(b: &Browser, gen0: u64) -> Res<()> {
    if b.generation.load(std::sync::atomic::Ordering::SeqCst) == gen0 {
        Ok(())
    } else {
        Err("the account changed meanwhile; nothing was done, try again".into())
    }
}

fn ok(v: &Value) -> Res<()> {
    match v {
        Value::Bool(true) => Ok(()),
        Value::String(s) => Err(s.clone()),
        other => Err(format!("failed: {other}")),
    }
}

pub fn mime_of(name: &str) -> &'static str {
    match name
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "mp4" => "video/mp4",
        "mov" => "video/quicktime",
        "pdf" => "application/pdf",
        _ => "image/jpeg",
    }
}

pub fn file_arg(path: &str, cwd: &str) -> Res<(String, &'static str, String)> {
    use base64::Engine;
    let full = crate::proto::resolve_path(cwd, path);
    let bytes = std::fs::read(&full).map_err(|e| format!("{full}: {e}"))?;
    let name = std::path::Path::new(&full)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("file")
        .to_string();
    let mime = mime_of(&name);
    Ok((
        name,
        mime,
        base64::engine::general_purpose::STANDARD.encode(bytes),
    ))
}

async fn type_into(b: &Browser, t: &Tab, text: &str) -> Res<()> {
    for (k, l) in text.split('\n').enumerate() {
        if k > 0 {
            b.key(t, "Enter", "Enter", 13, 8).await?;
        }
        if !l.is_empty() {
            b.insert_text(t, l).await?;
        }
    }
    Ok(())
}

pub async fn post(d: &Daemon, args: &[String], cwd: &str, out: &Out) -> Res<()> {
    let a = parse(args, &["img", "video", "to"], &["dry"])?;
    let text = a.pos.join(" ");
    let imgs = a.opts_all("img");
    let videos = a.opts_all("video");
    if text.is_empty() && imgs.is_empty() && videos.is_empty() {
        return Err(
            "usage: post <text> [--img file]... [--video file]... [--to public|friends|me]".into(),
        );
    }
    let audience = a.opt("to").map(|s| match s {
        "public" | "friends" | "me" => Ok(s.to_string()),
        _ => Err("--to must be public|friends|me".to_string()),
    });
    let audience = audience.transpose()?;
    // photos and videos ride the same composer file input
    let files: Vec<_> = imgs
        .iter()
        .chain(videos.iter())
        .map(|p| file_arg(p, cwd))
        .collect::<Res<_>>()?;
    let b = d.browser(out).await?;
    let gen0 = b.generation.load(std::sync::atomic::Ordering::SeqCst);
    // mutations hold the shared side of the account lock; an account import takes the exclusive side
    let _account = d.account.read().await;
    if b.generation.load(std::sync::atomic::Ordering::SeqCst) != gen0 {
        return Err(
            "the account changed while this command waited; nothing was done, try again".into(),
        );
    }
    let t = b.acquire().await?;
    same_account(&b, gen0)?;
    let pressed = std::sync::atomic::AtomicBool::new(false);
    let r = async {
        let profile = crate::ops::profile_path(d, &b, "me").await?;
        b.goto(&t, &format!("https://www.facebook.com{profile}")).await?;
        ok(&b.eval(&t, "window.__fb.composeOpen()").await?)?;
        if !text.is_empty() {
            ok(&b.eval(&t, "window.__fb.composeFocus()").await?)?;
            type_into(&b, &t, &text).await?;
        }
        ok(&b.eval(&t, &format!("window.__fb.composeCheck({})", json!(text))).await?)?;
        for (name, mime, b64) in &files {
            ok(&b
                .eval(
                    &t,
                    &format!(
                        "window.__fb.composeAttach({},{},{})",
                        json!(name),
                        json!(mime),
                        json!(b64)
                    ),
                )
                .await?)?;
        }
        if let Some(aud) = &audience {
            ok(&b
                .eval(&t, &format!("window.__fb.composeAudience({})", json!(aud)))
                .await?)?;
        }
        if a.flag("dry") {
            b.eval(
                &t,
                "document.querySelector('[role=dialog] [role=button]').click()",
            )
            .await?;
            out.line("dry: composer filled, not posted");
            return Ok(());
        }
        ok(&b.eval(&t, &format!("window.__fb.composePrepare({})", json!(text))).await?)?;
        let uid = crate::ops::uid(d, &b).await?;
        let mut events = b.cdp.subscribe();
        b.cdp.call(Some(&t.session), "Network.enable", json!({"maxTotalBufferSize":4194304,"maxResourceBufferSize":2097152,"maxPostDataSize":1048576})).await?;
        // Last chance to stop, after all awaited capture setup and before pressing Post.
        let ready = same_account(&b, gen0).and_then(|()| {
            if out.cancelled() {
                Err("cancelled by client; nothing was posted".to_string())
            } else {
                Ok(())
            }
        });
        if let Err(e) = ready {
            let _ = b.cdp.call(Some(&t.session), "Network.disable", json!({})).await;
            return Err(e);
        }
        pressed.store(true, std::sync::atomic::Ordering::SeqCst);
        let receipt = async {
            let press = async { ok(&b.eval(&t, &format!("window.__fb.composePress({})", json!(text))).await?) };
            // Read the network events while Post is pressed: composePress can wait 90 s for the
            // dialog to close, and events left unread that long can overflow the queue. FB's
            // composer may also take minutes to answer on a slow connection.
            let create = async {
                tokio::time::timeout(Duration::from_secs(150), created_post(&b, &t, &uid, &mut events))
                    .await
                    .map_err(|_| "creation response timed out".to_string())?
            };
            let ((), created) = tokio::try_join!(press, create)?;
            match created {
                Created::Story(path) => {
                    if !read_back(&b, &t, &path, &text, 15000).await? {
                        return Err("created post content could not be read back".into());
                    }
                    Ok((true, Some(path)))
                }
                Created::Pending(path) => {
                    let published = match &path {
                        Some(p) => published_soon(&b, &t, p, &text, out).await,
                        None => false,
                    };
                    Ok((published, path))
                }
            }
        }.await;
        let _ = b.cdp.call(Some(&t.session), "Network.disable", json!({})).await;
        let (verified, path) = receipt.map_err(|e: String| format!("post may have been published, but no verified receipt: {e}; inspect `fb posts me` before retrying"))?;
        match path {
            Some(path) => {
                let status = if verified { "posted" } else { "pending" };
                out.line(format!("{status}\t{}\t{path}", d.refs.put('p', &path)));
            }
            None => out.line("pending"),
        }

        Ok(())
    }
    .await;
    // After Post, an unconfirmed publish may still be uploading or resubmitting in this
    // page: a frozen or reused tab would cut it off, so park it live and unused.
    if pressed.load(std::sync::atomic::Ordering::SeqCst) && r.is_err() {
        b.release_live(t).await;
    } else {
        b.release(t).await;
    }
    r
}

/// What a create response proves.
#[derive(Debug, PartialEq)]
enum Created {
    Story(String),
    /// Facebook accepted the post and publishes it later: the response has no story yet, only
    /// its future `story_id`. Facebook's composer calls this a pending post and waits for it.
    /// The path is None when the response names no post id.
    Pending(Option<String>),
}

/// The post a pending response will become. `story_id` is base64 of `S:_I<actor>:...:<post>`.
fn future_post_path(story_id: &str, post_id: &Value, uid: &str) -> Res<Option<String>> {
    use base64::Engine;
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(story_id)
        .ok()
        .and_then(|b| String::from_utf8(b).ok())
        .unwrap_or_default();
    let actor = decoded.split(':').nth(1).and_then(|p| p.strip_prefix("_I"));
    if actor.is_some_and(|a| a != uid) {
        return Err("creation actor mismatch".into());
    }
    let post = match post_id {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        _ if actor.is_some() => decoded.rsplit(':').next().unwrap_or("").to_string(),
        _ => String::new(),
    };
    let valid = !post.is_empty() && post.chars().all(|c| c.is_ascii_alphanumeric());
    Ok(valid.then(|| format!("/{uid}/posts/{post}")))
}

/// None means a transient failure: Facebook's composer resubmits those by itself.
fn parse_created(body: &str, uid: &str) -> Res<Option<Created>> {
    let mut paths = std::collections::HashSet::new();
    let mut pending = None;
    for line in body
        .trim_start()
        .strip_prefix("for (;;);")
        .unwrap_or(body)
        .lines()
        .filter(|l| !l.trim().is_empty())
    {
        let value: Value = serde_json::from_str(line).map_err(|_| "invalid creation response")?;
        if let Some(errors) = value["errors"].as_array().filter(|e| !e.is_empty()) {
            if errors.iter().all(|e| e["is_transient"] == true) {
                return Ok(None);
            }
            return Err("Facebook rejected the creation request".into());
        }
        let create = &value["data"]["story_create"];
        let story = &create["story"];
        if story.is_null() {
            if let Some(id) = create["story_id"].as_str().filter(|id| !id.is_empty()) {
                pending = Some(future_post_path(id, &create["post_id"], uid)?);
            }
            continue;
        }
        if story["default_actor"]["id"].as_str() != Some(uid) {
            return Err("creation actor mismatch".into());
        }
        let path = crate::ops::fb_path(story["url"].as_str().ok_or("created story URL missing")?)
            .filter(|p| crate::ops::is_post_path(p))
            .ok_or("invalid created story URL")?;
        paths.insert(path);
    }
    match (paths.len(), pending) {
        (1, _) => Ok(paths.into_iter().next().map(Created::Story)),
        (0, Some(path)) => Ok(Some(Created::Pending(path))),
        _ => Err("unique creation identity missing".into()),
    }
}

/// The request id if this Network event sends a ComposerStoryCreateMutation.
fn creation_request_id(event: &crate::cdp::Event) -> Option<&str> {
    if event.method != "Network.requestWillBeSent" {
        return None;
    }
    let p = &event.params;
    if p["request"]["method"] != "POST"
        || !crate::ops::fb_path(p["request"]["url"].as_str().unwrap_or(""))
            .is_some_and(|p| p.starts_with("/api/graphql/"))
        || !p["request"]["postData"].as_str().is_some_and(|s| {
            s.split('&')
                .any(|v| v == "fb_api_req_friendly_name=ComposerStoryCreateMutation")
        })
    {
        return None;
    }
    p["requestId"].as_str()
}

async fn created_post(
    b: &Browser,
    t: &Tab,
    uid: &str,
    events: &mut tokio::sync::broadcast::Receiver<crate::cdp::Event>,
) -> Res<Created> {
    let mut request: Option<String> = None;
    loop {
        let event = match events.recv().await {
            Ok(event) => event,
            // Other tabs' events overflowed the queue; the creation answer may still come.
            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
            Err(_) => return Err("creation events lost".into()),
        };
        if event.session.as_deref() != Some(&t.session) {
            continue;
        }
        let p = &event.params;
        let id = p["requestId"].as_str().unwrap_or("");
        if let Some(creation) = creation_request_id(&event) {
            // FB's composer resubmits a failed creation itself: follow the
            // newest request instead of failing on the second one.
            request = Some(creation.to_string());
        }
        if request.as_deref() != Some(id) {
            continue;
        }
        if event.method == "Network.loadingFailed" {
            // Facebook's composer may resubmit; the caller's timeout ends the wait if it does not.
            request = None;
            continue;
        }
        if event.method != "Network.loadingFinished" {
            continue;
        }
        let response = b
            .cdp
            .call(
                Some(&t.session),
                "Network.getResponseBody",
                json!({"requestId":id}),
            )
            .await?;
        let raw = response["body"].as_str().ok_or("creation body missing")?;
        let decoded;
        let body = if response["base64Encoded"] == true {
            use base64::Engine;
            decoded = String::from_utf8(
                base64::engine::general_purpose::STANDARD
                    .decode(raw)
                    .map_err(|_| "invalid creation body")?,
            )
            .map_err(|_| "invalid creation encoding")?;
            decoded.as_str()
        } else {
            raw
        };
        match parse_created(body, uid)? {
            Some(created) => return Ok(created),
            None => request = None,
        }
    }
}

/// Open the post and compare its rendered body with what was posted.
async fn read_back(b: &Browser, t: &Tab, path: &str, text: &str, ms: u32) -> Res<bool> {
    b.goto(t, &format!("https://www.facebook.com{path}"))
        .await?;
    let js = format!(
        "window.__fb.waitFor(()=>{{window.__fbFeed.expand();const r=window.__fb.postRoot();return r&&window.__fb.postText(r.querySelector('[data-ad-rendering-role=story_message]'))===window.__fb.clean({})}},{ms})",
        json!(text)
    );
    Ok(b.eval(t, &js).await? == Value::Bool(true))
}

/// Wait for a pending post to appear on its own page (a redirect to the profile proves nothing).
/// ponytail: fixed one-minute wait; slower publishes such as video encoding report `pending`.
async fn published_soon(b: &Browser, t: &Tab, path: &str, text: &str, out: &Out) -> bool {
    let poll = async {
        while !out.cancelled() {
            if read_back(b, t, path, text, 5000).await.unwrap_or(false)
                && b.eval(t, "location.pathname+location.search")
                    .await
                    .is_ok_and(|v| v.as_str().is_some_and(crate::ops::is_post_path))
            {
                return true;
            }
            tokio::time::sleep(Duration::from_secs(5)).await;
        }
        false
    };
    // a stalled page load must end in the known `pending` receipt, not the command's timeout
    tokio::time::timeout(Duration::from_secs(60), poll)
        .await
        .unwrap_or(false)
}

async fn open_post(b: &Browser, t: &Tab, path: &str) -> Res<()> {
    b.goto(t, &format!("https://www.facebook.com{path}"))
        .await?;
    if b.eval(t, "window.__fb.postReady()").await? != Value::Bool(true) {
        return Err("post not found".into());
    }
    Ok(())
}

pub async fn delete(d: &Daemon, args: &[String], out: &Out) -> Res<()> {
    let a = parse(args, &[], &[])?;
    let spec = a.pos.first().ok_or("usage: delete <post>")?;
    let path = resolve_post_strict(d, spec).await?;
    let b = d.browser(out).await?;
    let gen0 = b.generation.load(std::sync::atomic::Ordering::SeqCst);
    // mutations hold the shared side of the account lock; an account import takes the exclusive side
    let _account = d.account.read().await;
    if b.generation.load(std::sync::atomic::Ordering::SeqCst) != gen0 {
        return Err(
            "the account changed while this command waited; nothing was done, try again".into(),
        );
    }
    let t = b.acquire().await?;
    same_account(&b, gen0)?;
    let r = async {
        open_post(&b, &t, &path).await?;
        ok(&b.eval(&t, "window.__fb.postDeleteOpen()").await?)?;
        // last chance to stop: after the confirm click the post is gone
        same_account(&b, gen0)?;
        if out.cancelled() {
            return Err("cancelled by client; nothing was deleted".into());
        }
        ok(&b.eval(&t, "window.__fb.postDeleteConfirm()").await?)?;
        out.line("deleted");
        Ok(())
    }
    .await;
    b.release(t).await;
    r
}

/// Follow a profile's public posts without a friend request, or with --undo stop following.
/// Idempotent: a profile already in the asked state is reported, nothing is pressed. --dry
/// only reports the state. A public figure's header shows Follow; a person who also takes
/// friend requests keeps it in the header's "…" menu.
pub async fn follow(d: &Daemon, args: &[String], out: &Out) -> Res<()> {
    let a = parse(args, &[], &["undo", "dry"])?;
    let spec = a
        .pos
        .first()
        .ok_or("usage: follow <ref|url|@handle|id> [--undo] [--dry]")?;
    let on = !a.flag("undo");
    let b: Arc<Browser> = d.browser(out).await?;
    let gen0 = b.generation.load(std::sync::atomic::Ordering::SeqCst);
    // mutations hold the shared side of the account lock; an account import takes the exclusive side
    let _account = d.account.read().await;
    if b.generation.load(std::sync::atomic::Ordering::SeqCst) != gen0 {
        return Err(
            "the account changed while this command waited; nothing was done, try again".into(),
        );
    }
    // the app passes a profile path or ref; a searched name could pick a different person
    let p = crate::ops::profile_path(d, &b, spec).await?;
    let t = b.acquire().await?;
    same_account(&b, gen0)?;
    let text_of = |v: &Value| -> Res<String> {
        match v {
            Value::String(s) => Ok(s.clone()),
            other => Err(format!("unexpected follow state: {other}")),
        }
    };
    let r = async {
        b.goto(&t, &format!("https://www.facebook.com{p}")).await?;
        let state = text_of(&b.eval(&t, "window.__fb.followState()").await?)?;
        // only the asked state counts: an error state is never a done unfollow
        let want = if on { "following" } else { "can-follow" };
        let done = |s: &str| s == want;
        match state.as_str() {
            "following" | "can-follow" if a.flag("dry") => {
                out.line(format!("dry: {state}"));
                return Ok(());
            }
            s @ ("following" | "can-follow") if done(s) => {
                out.line(if on { "already following" } else { "not following" });
                return Ok(());
            }
            "following" | "can-follow" => {}
            "ambiguous" => {
                return Err("several Follow controls on this page; nothing was pressed".into());
            }
            "no-profile" => return Err("this is not a profile page".into()),
            _ => return Err("this profile offers no Follow".into()),
        }
        same_account(&b, gen0)?;
        if out.cancelled() {
            return Err("cancelled by client; nothing was pressed".into());
        }
        let prepared = text_of(&b.eval(&t, &format!("window.__fb.followPrepare({on})")).await?)?;
        if prepared != "ready" && !done(&prepared) {
            return Err(format!("follow change not confirmed (state: {prepared})"));
        }
        same_account(&b, gen0)?;
        if out.cancelled() {
            return Err("cancelled by client; nothing was pressed".into());
        }
        if prepared == "ready" {
            let pressed = text_of(&b.eval(&t, "window.__fb.followPress()").await?)?;
            if pressed != "pressed" {
                return Err(format!("follow change not confirmed (state: {pressed})"));
            }
        }
        let after = text_of(&b.eval(&t, &format!("window.__fb.followConfirm({on})")).await?)?;
        if done(&after) {
            out.line(if on { "following" } else { "unfollowed" });
            Ok(())
        } else {
            Err(format!("follow change not confirmed (state: {after})"))
        }
    }
    .await;
    b.release(t).await;
    r
}

pub async fn comment(d: &Daemon, args: &[String], out: &Out) -> Res<()> {
    let a = parse(args, &[], &[])?;
    let spec = a.pos.first().ok_or("usage: comment <post> <text>")?;
    let text = a.pos[1..].join(" ");
    if text.is_empty() {
        return Err("usage: comment <post> <text>".into());
    }
    let path = resolve_post_strict(d, spec).await?;
    let b = d.browser(out).await?;
    let gen0 = b.generation.load(std::sync::atomic::Ordering::SeqCst);
    // mutations hold the shared side of the account lock; an account import takes the exclusive side
    let _account = d.account.read().await;
    if b.generation.load(std::sync::atomic::Ordering::SeqCst) != gen0 {
        return Err(
            "the account changed while this command waited; nothing was done, try again".into(),
        );
    }
    let t = b.acquire().await?;
    same_account(&b, gen0)?;
    let r = async {
        open_post(&b, &t, &path).await?;
        ok(&b.eval(&t, "window.__fb.commentFocus()").await?)?;
        b.eval(&t, "window.__fb.commentMark()").await?;
        type_into(&b, &t, &text).await?;
        same_account(&b, gen0)?;
        if out.cancelled() {
            return Err("cancelled by client; nothing was commented".into());
        }
        b.key(&t, "Enter", "Enter", 13, 0).await?;
        let deadline = Instant::now() + Duration::from_secs(15);
        let js = format!("window.__fb.commentSent({})", json!(text));
        // our own new comment, by content: someone else's comment arriving must not confirm ours
        while b.eval(&t, &js).await? != Value::Bool(true) {
            if Instant::now() > deadline {
                return Err("comment not confirmed (timeout)".into());
            }
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
        out.line("commented");
        Ok(())
    }
    .await;
    b.release(t).await;
    r
}

/// How a selected reaction button starts, per language ("Remove Love from …").
const REMOVE_PREFIXES: [&str; 4] = ["remove ", "retirer ", "supprimer ", "удалить "];
/// What follows the reaction name in a selected button ("… from <author>'s post",
/// French "… de la publication de <author>").
const TARGET_SEPARATORS: [&str; 5] = [
    " from ",
    " de la publication",
    " à la publication",
    " sur la publication",
    // Russian: "Удалить Ух ты! из публикации <author>"
    " из публикации",
];

/// The reaction precedes the author in "Remove Love from <author>'s post".
/// Keep localized suffix matching ("Yêu thích" also ends with "thích").
/// A picker entry's reaction name. A selected Like turns its entry into a removal
/// in some languages (Russian: "Удалить реакцию «Нравится»"), which must still
/// name Like for the label checks below.
fn picker_name(label: &str) -> String {
    let l = label.to_lowercase();
    let l = l.strip_prefix("удалить реакцию ").unwrap_or(&l);
    l.trim_matches(|c| matches!(c, '"' | '«' | '»' | '“' | '”' | '„'))
        .to_owned()
}

fn current_reaction(label: &str, picker: &[String]) -> Option<usize> {
    let l = label.to_lowercase();
    let reaction = REMOVE_PREFIXES
        .iter()
        .find_map(|prefix| l.strip_prefix(prefix))
        .and_then(|rest| {
            TARGET_SEPARATORS
                .iter()
                .filter_map(|separator| rest.split_once(separator).map(|(reaction, _)| reaction))
                .min_by_key(|reaction| reaction.len())
        })
        .unwrap_or(l.as_str());
    picker
        .iter()
        .enumerate()
        .filter(|(_, p)| !p.is_empty() && reaction.ends_with(p.as_str()))
        .max_by_key(|(_, p)| p.len())
        .map(|(i, _)| i)
}

/// Send a friend request from a profile page. Idempotent: an existing
/// friendship or a pending request is reported, not re-clicked.
pub async fn friend_add(d: &Daemon, args: &[String], out: &Out) -> Res<()> {
    let a = parse(args, &[], &[])?;
    let spec = a.pos.first().ok_or("usage: friend-add <who>")?;
    let b: Arc<Browser> = d.browser(out).await?;
    let p = crate::ops::profile_path(d, &b, spec).await?;
    let gen0 = b.generation.load(std::sync::atomic::Ordering::SeqCst);
    // mutations hold the shared side of the account lock; an account import takes the exclusive side
    let _account = d.account.read().await;
    if b.generation.load(std::sync::atomic::Ordering::SeqCst) != gen0 {
        return Err(
            "the account changed while this command waited; nothing was done, try again".into(),
        );
    }
    let t = b.acquire().await?;
    same_account(&b, gen0)?;
    let text_of = |v: &Value| -> Res<String> {
        match v {
            Value::String(s) => Ok(s.clone()),
            other => Err(format!("unexpected friend button state: {other}")),
        }
    };
    let r = async {
        b.goto(&t, &format!("https://www.facebook.com{p}")).await?;
        let state = text_of(&b.eval(&t, "window.__fb.friendState()").await?)?;
        match state.as_str() {
            "friends" => {
                out.line("already friends");
                return Ok(());
            }
            "requested" => {
                out.line("friend request already sent");
                return Ok(());
            }
            "can-add" => {}
            _ => return Err("no Add friend button on this profile".into()),
        }
        same_account(&b, gen0)?;
        if out.cancelled() {
            return Err("cancelled by client; no request was sent".into());
        }
        let after = text_of(&b.eval(&t, "window.__fb.friendAdd()").await?)?;
        match after.as_str() {
            "requested" | "friends" => {
                out.line("friend request sent");
                Ok(())
            }
            other => Err(format!("friend request not confirmed (state: {other})")),
        }
    }
    .await;
    b.release(t).await;
    r
}

fn reaction_neutral(label: &str, picker: &[String]) -> bool {
    let l = label.to_lowercase();
    picker.first().is_some_and(|first| {
        !first.is_empty()
            && (l == *first
                // "Like <author>'s post"; a bare prefix would also take a selected state
                // that begins with the Like word ("Gefällt mir nicht mehr")
                || (l.starts_with(&format!("{first} "))
                    && (l.ends_with("'s post") || l.ends_with("\u{2019}s post")))
                || l.starts_with(&format!("{first},"))
                || l.starts_with(&format!("react with {first} to "))
                || l.starts_with(&format!("réagir avec {first} à "))
                // Russian: "Поставить Нравится публикации <author>"
                || l.starts_with(&format!("поставить {first} ")))
    })
}

/// Neutral labels can name both Like and an author; neither confirms a selection.
fn reaction_landed(label: &str, picker: &[String], idx: usize) -> bool {
    !reaction_neutral(label, picker) && current_reaction(label, picker) == Some(idx)
}

/// Join a group. Idempotent: already joined / already requested is reported,
/// not re-clicked. A group that asks membership questions gets its questions
/// reported back; answering them is the user's call, nothing is submitted.
pub async fn group_join(d: &Daemon, args: &[String], out: &Out) -> Res<()> {
    let a = parse(args, &[], &[])?;
    let spec = a.pos.first().ok_or("usage: group-join <group>")?;
    let b: Arc<Browser> = d.browser(out).await?;
    let p = crate::ops::group_path(d, spec)?;
    let gen0 = b.generation.load(std::sync::atomic::Ordering::SeqCst);
    // mutations hold the shared side of the account lock; an account import takes the exclusive side
    let _account = d.account.read().await;
    if b.generation.load(std::sync::atomic::Ordering::SeqCst) != gen0 {
        return Err(
            "the account changed while this command waited; nothing was done, try again".into(),
        );
    }
    let t = b.acquire().await?;
    same_account(&b, gen0)?;
    let r = async {
        b.goto(&t, &format!("https://www.facebook.com{p}")).await?;
        let state = match b.eval(&t, "window.__fb.groupState()").await? {
            Value::String(s) => s,
            other => return Err(format!("unexpected group button state: {other}")),
        };
        match state.as_str() {
            "joined" => {
                out.line("already joined");
                return Ok(());
            }
            "pending" => {
                out.line("join request already pending");
                return Ok(());
            }
            "can-join" => {}
            _ => return Err("no Join group button on this group page".into()),
        }
        same_account(&b, gen0)?;
        if out.cancelled() {
            return Err("cancelled by client; no join was attempted".into());
        }
        let after = match b.eval(&t, "window.__fb.groupJoin()").await? {
            Value::String(s) => s,
            other => return Err(format!("unexpected join result: {other}")),
        };
        if let Some(qs) = after.strip_prefix("questions:") {
            // TSV so callers can present the questions and answer them with
            // group-apply: a count line, then one `q<TAB>question` per line
            let list: Vec<String> = serde_json::from_str(qs).unwrap_or_default();
            out.line(format!("questions\t{}", list.len()));
            for q in &list {
                out.line(format!("q\t{}", q.replace(['\t', '\n'], " ")));
            }
            return Ok(());
        }
        match after.as_str() {
            "joined" => {
                out.line("joined group");
                Ok(())
            }
            "pending" => {
                out.line("join requested; an admin must approve");
                Ok(())
            }
            other => Err(format!("join not confirmed (state: {other})")),
        }
    }
    .await;
    b.release(t).await;
    r
}

/// Leave a group. Idempotent: not a member is reported, not an error.
/// A pending join request is left alone (cancelling is a different action).
pub async fn group_leave(d: &Daemon, args: &[String], out: &Out) -> Res<()> {
    let a = parse(args, &[], &[])?;
    let spec = a.pos.first().ok_or("usage: group-leave <group>")?;
    let b: Arc<Browser> = d.browser(out).await?;
    let p = crate::ops::group_path(d, spec)?;
    let gen0 = b.generation.load(std::sync::atomic::Ordering::SeqCst);
    // mutations hold the shared side of the account lock; an account import takes the exclusive side
    let _account = d.account.read().await;
    if b.generation.load(std::sync::atomic::Ordering::SeqCst) != gen0 {
        return Err(
            "the account changed while this command waited; nothing was done, try again".into(),
        );
    }
    let t = b.acquire().await?;
    same_account(&b, gen0)?;
    let r = async {
        b.goto(&t, &format!("https://www.facebook.com{p}")).await?;
        let state = match b.eval(&t, "window.__fb.groupState()").await? {
            Value::String(s) => s,
            other => return Err(format!("unexpected group button state: {other}")),
        };
        match state.as_str() {
            "can-join" => {
                out.line("not a member of this group");
                return Ok(());
            }
            "pending" => {
                return Err(
                    "your join request is still pending; cancel it from the group page".into(),
                );
            }
            "joined" => {}
            _ => return Err("no membership button on this group page".into()),
        }
        same_account(&b, gen0)?;
        if out.cancelled() {
            return Err("cancelled by client; you are still a member".into());
        }
        let after = match b.eval(&t, "window.__fb.groupLeave()").await? {
            Value::String(s) => s,
            other => return Err(format!("unexpected leave result: {other}")),
        };
        match after.as_str() {
            "left" => {
                out.line("left group");
                Ok(())
            }
            other => Err(format!("leave not confirmed (state: {other})")),
        }
    }
    .await;
    b.release(t).await;
    r
}

/// Join a group that asks membership questions, answering them in order:
/// `group-apply <group> <answer>...`. Choice questions take the answer that
/// matches an option label; text questions take the answer as typed.
pub async fn group_apply(d: &Daemon, args: &[String], out: &Out) -> Res<()> {
    let a = parse(args, &[], &[])?;
    let spec = a
        .pos
        .first()
        .ok_or("usage: group-apply <group> <answer>...")?;
    let answers: Vec<String> = a.pos.iter().skip(1).cloned().collect();
    if answers.is_empty() {
        return Err("usage: group-apply <group> <answer>...".into());
    }
    let b: Arc<Browser> = d.browser(out).await?;
    let p = crate::ops::group_path(d, spec)?;
    let gen0 = b.generation.load(std::sync::atomic::Ordering::SeqCst);
    // mutations hold the shared side of the account lock; an account import takes the exclusive side
    let _account = d.account.read().await;
    if b.generation.load(std::sync::atomic::Ordering::SeqCst) != gen0 {
        return Err(
            "the account changed while this command waited; nothing was done, try again".into(),
        );
    }
    let t = b.acquire().await?;
    same_account(&b, gen0)?;
    let r = async {
        b.goto(&t, &format!("https://www.facebook.com{p}")).await?;
        let state = match b.eval(&t, "window.__fb.groupState()").await? {
            Value::String(s) => s,
            other => return Err(format!("unexpected group button state: {other}")),
        };
        match state.as_str() {
            "joined" => {
                out.line("already joined");
                return Ok(());
            }
            "pending" => {
                out.line("join request already pending");
                return Ok(());
            }
            "can-join" => {}
            _ => return Err("no Join group button on this group page".into()),
        }
        same_account(&b, gen0)?;
        if out.cancelled() {
            return Err("cancelled by client; no answers were submitted".into());
        }
        let after = match b
            .eval(&t, &format!("window.__fb.groupApply({})", json!(answers)))
            .await?
        {
            Value::String(s) => s,
            other => return Err(format!("unexpected apply result: {other}")),
        };
        match after.as_str() {
            "joined" => {
                out.line("joined group");
                Ok(())
            }
            "pending" | "submitted" => {
                out.line("answers submitted; an admin must approve");
                Ok(())
            }
            "no-questions" => {
                Err("this group shows no membership questions; use group-join instead".into())
            }
            other => Err(format!("answers not confirmed submitted (state: {other})")),
        }
    }
    .await;
    b.release(t).await;
    r
}

/// Message a Marketplace seller from the listing page: opens the listing's
/// chat popover, types the text, sends with Enter and verifies the message
/// landed in the conversation.
pub async fn listing_message(d: &Daemon, args: &[String], out: &Out) -> Res<()> {
    let a = parse(args, &[], &[])?;
    let spec = a
        .pos
        .first()
        .ok_or("usage: listing-message <listing> <text>")?;
    let text = a.pos.iter().skip(1).cloned().collect::<Vec<_>>().join(" ");
    if text.is_empty() {
        return Err("usage: listing-message <listing> <text>".into());
    }
    let path = if let Some(p) = d.refs.get(spec) {
        p
    } else {
        crate::ops::fb_path(spec).ok_or_else(|| format!("not a facebook url: {spec}"))?
    };
    if !path.starts_with("/marketplace/item/") {
        return Err(format!("'{spec}' is not a marketplace listing"));
    }
    let b: Arc<Browser> = d.browser(out).await?;
    let gen0 = b.generation.load(std::sync::atomic::Ordering::SeqCst);
    // mutations hold the shared side of the account lock; an account import takes the exclusive side
    let _account = d.account.read().await;
    if b.generation.load(std::sync::atomic::Ordering::SeqCst) != gen0 {
        return Err(
            "the account changed while this command waited; nothing was done, try again".into(),
        );
    }
    let t = b.acquire().await?;
    same_account(&b, gen0)?;
    let r = async {
        b.goto(&t, &format!("https://www.facebook.com{path}")).await?;
        ok(&b.eval(&t, "window.__fb.listingMessageOpen()").await?)?;
        // the conversation may already hold this text: only a new copy confirms the send
        let before = b
            .eval(&t, &format!("window.__fb.listingMessageCount({})", json!(text)))
            .await?;
        // one insert for the whole text: Enter keystrokes would send early
        b.insert_text(&t, &text).await?;
        same_account(&b, gen0)?;
        if out.cancelled() {
            return Err("cancelled by client; the message was not sent".into());
        }
        b.key(&t, "Enter", "Enter", 13, 0).await?;
        let sent = b
            .eval(
                &t,
                &format!(
                    "window.__fb.waitFor(()=>window.__fb.listingMessageSent({},{})||null,10000,200).then(v=>!!v)",
                    json!(text),
                    before
                ),
            )
            .await?;
        if sent != Value::Bool(true) {
            return Err("the message did not appear in the conversation".into());
        }
        out.line("message sent");
        Ok(())
    }
    .await;
    b.release(t).await;
    r
}

/// Create a Marketplace listing ("Item for sale") from the desktop sell form.
/// Facebook requires a title (100 chars max), a price (0 = free), a condition,
/// a category and at least one photo; every gap is a loud error, never a
/// half-filled form left behind. Prints listed<TAB>ref<TAB>path when Facebook
/// lands on the new listing.
pub async fn sell(d: &Daemon, args: &[String], cwd: &str, out: &Out) -> Res<()> {
    let a = parse(
        args,
        &["price", "desc", "condition", "category", "img", "video"],
        &["dry"],
    )?;
    let title = a.pos.join(" ");
    if title.is_empty() || title.chars().count() > 100 {
        return Err("usage: sell <title, 100 chars max> --price N [--condition new|like-new|good|fair] [--category name] [--desc text] [--img file]... [--video file]".into());
    }
    let price = a.opt("price").ok_or("--price is required (0 = free)")?;
    if price.parse::<f64>().map(|p| p < 0.0).unwrap_or(true) {
        return Err(format!("--price must be a number, got '{price}'"));
    }
    let condition = a.opt("condition").map(|s| match s {
        "new" | "like-new" | "good" | "fair" => Ok(s.to_string()),
        _ => Err("--condition must be new|like-new|good|fair".to_string()),
    });
    let condition = condition.transpose()?;
    let imgs = a.opts_all("img");
    let videos = a.opts_all("video");
    if imgs.is_empty() && videos.is_empty() {
        return Err("a listing needs at least one photo (--img) or video (--video)".into());
    }
    if imgs.len() + videos.len() > 10 {
        return Err("marketplace allows at most 10 photos/videos per listing".into());
    }
    let files: Vec<_> = imgs
        .iter()
        .chain(videos.iter())
        .map(|p| file_arg(p, cwd))
        .collect::<Res<_>>()?;
    let b = d.browser(out).await?;
    let gen0 = b.generation.load(std::sync::atomic::Ordering::SeqCst);
    // mutations hold the shared side of the account lock; an account import takes the exclusive side
    let _account = d.account.read().await;
    if b.generation.load(std::sync::atomic::Ordering::SeqCst) != gen0 {
        return Err(
            "the account changed while this command waited; nothing was done, try again".into(),
        );
    }
    let t = b.acquire().await?;
    same_account(&b, gen0)?;
    let r = async {
        b.goto(&t, "https://www.facebook.com/marketplace/create/item")
            .await?;
        // the form counts as open once its title field exists
        let opened = b
            .eval(
                &t,
                "window.__fb.waitFor(()=>document.querySelector('input[aria-label^=\"Title\" i],input[placeholder^=\"Title\" i]'),15000).then(v=>!!v)",
            )
            .await?;
        if opened != Value::Bool(true) {
            return Err("the marketplace sell form did not open".into());
        }
        for (name, mime, b64) in &files {
            ok(&b
                .eval(
                    &t,
                    &format!(
                        "window.__fb.sellAttach({},{},{})",
                        json!(name),
                        json!(mime),
                        json!(b64)
                    ),
                )
                .await?)?;
        }
        ok(&b
            .eval(
                &t,
                &format!("window.__fb.sellSet('Title',{})", json!(title)),
            )
            .await?)?;
        ok(&b
            .eval(
                &t,
                &format!("window.__fb.sellSet('Price',{})", json!(price)),
            )
            .await?)?;
        if let Some(desc) = a.opt("desc") {
            ok(&b
                .eval(
                    &t,
                    &format!("window.__fb.sellSet('Description',{})", json!(desc)),
                )
                .await?)?;
        }
        if let Some(cond) = &condition {
            ok(&b
                .eval(
                    &t,
                    &format!("window.__fb.sellPick('condition',{})", json!(cond)),
                )
                .await?)?;
        }
        if let Some(cat) = a.opt("category") {
            ok(&b
                .eval(
                    &t,
                    &format!("window.__fb.sellPick('category',{})", json!(cat)),
                )
                .await?)?;
        }
        if a.flag("dry") {
            out.line("dry: listing form filled, not published");
            return Ok(());
        }
        ok(&b.eval(&t, "window.__fb.sellNext()").await?)?;
        same_account(&b, gen0)?;
        if out.cancelled() {
            return Err("cancelled by client; the listing was not published".into());
        }
        let done = match b.eval(&t, "window.__fb.sellPublish()").await? {
            Value::String(s) => s,
            other => return Err(format!("unexpected publish result: {other}")),
        };
        // only a listing address or Facebook's "listing is live" confirms it
        match done.as_str() {
            s if s.starts_with("/marketplace/item/") => {
                out.line(format!("listed\t{}\t{done}", d.refs.put('u', &done)))
            }
            "live" => {
                out.line("listed (confirmation seen; open Marketplace > Your listings to view it)")
            }
            "publish not confirmed" => {
                return Err("Publish was pressed but Facebook did not confirm the listing; \
                    check Marketplace > Your listings before trying again"
                    .into())
            }
            other => return Err(format!("the listing was not published: {other}")),
        }
        Ok(())
    }
    .await;
    b.release(t).await;
    r
}

/// Hover the Like button and poll for the reaction picker, anchored on
/// the button's coordinates. Round 0 hovers once and waits up to ~4s;
/// round 1 first hovers away and back (a stuck hover can swallow the
/// picker) and waits ~2.5s. Returns the last probe either way; the
/// caller decides from its labels.
async fn probe_picker(b: &Browser, t: &Tab, idx: usize, x: f64, y: f64, round: u32) -> Res<Value> {
    if round > 0 {
        // A picker left open by the previous attempt is still the
        // picker: reuse it instead of tagging it as scenery (tagging
        // it would leave the retry waiting for a second picker that
        // can never appear while the first is open).
        let open = b
            .eval(t, &format!("window.__fb.reactionPick({idx}, {x}, {y})"))
            .await?;
        if open["labels"].as_array().is_some_and(|l| !l.is_empty()) {
            return Ok(open);
        }
        b.hover(t, x + 40.0, y + 60.0).await?;
        tokio::time::sleep(Duration::from_millis(250)).await;
        // The picker (if any) has closed again; re-tag what remains.
        b.eval(t, "window.__fb.markToolbars()").await?;
    }
    b.hover(t, x, y).await?;
    // Both rounds get the full window: on a slow machine each probe eval
    // is itself slow, and a short second window missed a 1.6s picker on
    // the macOS CI runner while Linux and Windows passed.
    let deadline = std::time::Instant::now() + Duration::from_millis(5000);
    loop {
        let pick = b
            .eval(t, &format!("window.__fb.reactionPick({idx}, {x}, {y})"))
            .await?;
        if pick["labels"].as_array().is_some_and(|l| !l.is_empty())
            || std::time::Instant::now() >= deadline
        {
            return Ok(pick);
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

pub async fn react(d: &Daemon, args: &[String], out: &Out) -> Res<()> {
    let a = parse(args, &[], &[])?;
    let spec = a
        .pos
        .first()
        .ok_or("usage: react <post> [like|love|care|haha|wow|sad|angry|none]")?;
    let kind = a.pos.get(1).map(String::as_str).unwrap_or("like");
    let idx = [
        "like", "love", "care", "haha", "wow", "sad", "angry", "none",
    ]
    .iter()
    .position(|k| *k == kind)
    .ok_or("reaction must be like|love|care|haha|wow|sad|angry|none")?;
    let path = resolve_post_strict(d, spec).await?;
    let b: Arc<Browser> = d.browser(out).await?;
    let gen0 = b.generation.load(std::sync::atomic::Ordering::SeqCst);
    // mutations hold the shared side of the account lock; an account import takes the exclusive side
    let _account = d.account.read().await;
    if b.generation.load(std::sync::atomic::Ordering::SeqCst) != gen0 {
        return Err(
            "the account changed while this command waited; nothing was done, try again".into(),
        );
    }
    let t = b.acquire().await?;
    same_account(&b, gen0)?;
    let r = async {
        open_post(&b, &t, &path).await?;
        let info = b.eval(&t, "window.__fb.likeInfo()").await?;
        let (x, y) = (
            info["x"].as_f64().ok_or("no like button")?,
            info["y"].as_f64().ok_or("no like button")?,
        );
        let label0 = info["label"].as_str().unwrap_or("").to_lowercase();
        // Picker labels identify localized reactions; button labels may also name the author.
        // The picker opens on hover after Facebook's own delay, which is not
        // fixed: hover and poll for it (one re-hover if it never comes)
        // instead of probing once after a fixed sleep. reactionPick anchors
        // on the button's coordinates, so a same-sized toolbar elsewhere
        // on the page cannot be mistaken for the picker.
        // Tag the toolbars already on the page: the picker is the one
        // that appears after the hover, whenever that is.
        b.eval(&t, "window.__fb.markToolbars()").await?;
        let mut pick = probe_picker(&b, &t, idx.min(6), x, y, 0).await?;
        if !pick["labels"].as_array().is_some_and(|l| !l.is_empty()) {
            pick = probe_picker(&b, &t, idx.min(6), x, y, 1).await?;
        }
        let labels: Vec<String> = match pick["labels"].as_array() {
            Some(a) if !a.is_empty() => a
                .iter()
                .map(|l| picker_name(l.as_str().unwrap_or("")))
                .collect(),
            _ => return Err("reaction picker did not open (nothing was changed)".into()),
        };
        let label = label0.clone();
        let liked = !reaction_neutral(&label, &labels);
        let current = if liked {
            current_reaction(&label, &labels)
        } else {
            None
        };
        same_account(&b, gen0)?;
        if out.cancelled() {
            return Err("cancelled by client; reaction unchanged".into());
        }
        if idx == 7 {
            if liked {
                ok(&b.eval(&t, "window.__fb.likePress()").await?)?;
                // A different selected reaction must not confirm removal.
                let deadline = std::time::Instant::now() + Duration::from_millis(6000);
                let mut off = false;
                while std::time::Instant::now() < deadline {
                    tokio::time::sleep(Duration::from_millis(300)).await;
                    let now = b.eval(&t, "window.__fb.likeInfo()").await?;
                    if reaction_neutral(now["label"].as_str().unwrap_or(""), &labels) {
                        off = true;
                        break;
                    }
                }
                if !off {
                    return Err("the reaction did not come off the post".into());
                }
            }
        } else if current != Some(idx) {
            // Click, then verify the button now names the picked reaction;
            // one full retry, then report honestly instead of success.
            let mut landed = false;
            for attempt in 0..2 {
                if attempt > 0 {
                    pick = probe_picker(&b, &t, idx.min(6), x, y, 1).await?;
                    if !pick["labels"].as_array().is_some_and(|l| !l.is_empty()) {
                        break;
                    }
                }
                let (px, py) = (
                    pick["x"].as_f64().ok_or("reaction picker not found")?,
                    pick["y"].as_f64().ok_or("reaction picker not found")?,
                );
                b.click(&t, px, py).await?;
                let deadline = std::time::Instant::now() + Duration::from_millis(6000);
                loop {
                    let now = b.eval(&t, "window.__fb.likeInfo()").await?;
                    let l = now["label"].as_str().unwrap_or("").to_lowercase();
                    if reaction_landed(&l, &labels, idx) {
                        landed = true;
                        break;
                    }
                    if std::time::Instant::now() >= deadline {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(250)).await;
                }
                if landed {
                    break;
                }
            }
            if !landed {
                // Say what the page actually shows: a diagnosable error
                // beats a bare failure (this is how a macOS-only miss
                // was pinned down — label and picker state tell apart a
                // click that missed from a label that never changed).
                let now = b.eval(&t, "window.__fb.likeInfo()").await?;
                let l = now["label"].as_str().unwrap_or("");
                let still = b
                    .eval(
                        &t,
                        &format!("window.__fb.reactionPick({}, {x}, {y})", idx.min(6)),
                    )
                    .await?;
                let picker_open = still["labels"].as_array().is_some_and(|a| !a.is_empty());
                return Err(format!(
                    "the reaction did not land on the post (button reads '{l}', picker {})",
                    if picker_open { "still open" } else { "closed" }
                ));
            }
        }
        let _ = b
            .eval(&t, "document.activeElement&&document.activeElement.blur()")
            .await;
        tokio::time::sleep(Duration::from_millis(700)).await;
        out.line(format!("reacted {kind}"));
        Ok(())
    }
    .await;
    b.release(t).await;
    r
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_response_with_a_story_is_a_receipt() {
        let body = r#"for (;;);{"data":{"story_create":{"story":{"url":"https://www.facebook.com/a/posts/pfbid1","default_actor":{"id":"7"}}}}}
{"label":"later","path":["story_create"],"data":{"x":1}}"#;
        assert_eq!(
            parse_created(body, "7"),
            Ok(Some(Created::Story("/a/posts/pfbid1".into())))
        );
    }

    #[test]
    fn create_response_without_a_story_yet_is_pending() {
        use base64::Engine;
        let id = |s: &str| base64::engine::general_purpose::STANDARD.encode(s);
        let pending = |create: Value| {
            parse_created(&json!({"data":{"story_create":create}}).to_string(), "7")
        };
        let want = |post: &str| Ok(Some(Created::Pending(Some(format!("/7/posts/{post}")))));
        assert_eq!(
            pending(json!({"story":null,"story_id":id("S:_I7:55:55"),"post_id":"55"})),
            want("55")
        );
        assert_eq!(
            pending(json!({"story":null,"story_id":id("S:_I7:55:55"),"post_id":55})),
            want("55")
        );
        // video stories put VK before the post id
        assert_eq!(
            pending(json!({"story":null,"story_id":id("S:_I7:VK:55")})),
            want("55")
        );
        assert_eq!(
            pending(json!({"story":null,"story_id":"opaque"})),
            Ok(Some(Created::Pending(None)))
        );
        assert_eq!(
            pending(json!({"story":null,"story_id":id("S:_I8:55:55"),"post_id":"55"})),
            Err("creation actor mismatch".to_string())
        );
    }

    #[test]
    fn create_response_without_any_identity_stays_an_error() {
        for body in [
            r#"{"data":{"story_create":{"story":null}}}"#,
            r#"{"data":{}}"#,
        ] {
            assert_eq!(
                parse_created(body, "7"),
                Err("unique creation identity missing".to_string())
            );
        }
    }

    #[test]
    fn creation_request_id_finds_only_the_composer_mutation() {
        let event = |method: &str, request_id: &str, url: &str, post_data: &str| {
            crate::cdp::Event {
                session: Some("s".into()),
                method: method.into(),
                params: json!({"requestId": request_id, "request": {"method": "POST", "url": url, "postData": post_data}}).into(),
            }
        };
        let url = "https://www.facebook.com/api/graphql/";
        let data = "fb_api_req_friendly_name=ComposerStoryCreateMutation&doc_id=1";
        assert_eq!(
            creation_request_id(&event("Network.requestWillBeSent", "42", url, data)),
            Some("42")
        );
        // FB resubmits with a new id; the caller follows the newest one.
        assert_ne!(
            creation_request_id(&event("Network.requestWillBeSent", "42", url, data)),
            creation_request_id(&event("Network.requestWillBeSent", "43", url, data))
        );
        assert_eq!(
            creation_request_id(&event(
                "Network.requestWillBeSent",
                "42",
                url,
                "fb_api_req_friendly_name=OtherMutation"
            )),
            None
        );
        assert_eq!(
            creation_request_id(&event("Network.loadingFinished", "42", url, data)),
            None
        );
        assert_eq!(
            creation_request_id(&event(
                "Network.requestWillBeSent",
                "42",
                "https://www.facebook.com/other/",
                data
            )),
            None
        );
    }

    #[test]
    fn create_response_errors_tell_transient_from_final() {
        assert_eq!(
            parse_created(r#"{"errors":[{"is_transient":true}]}"#, "7"),
            Ok(None)
        );
        assert_eq!(
            parse_created(r#"{"errors":[{"message":"no"}]}"#, "7"),
            Err("Facebook rejected the creation request".to_string())
        );
    }

    #[test]
    fn current_reaction_prefers_the_longest_matching_label() {
        let picker: Vec<String> = ["thích", "yêu thích", "thương thương", "haha"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert_eq!(current_reaction("Gỡ Yêu thích", &picker), Some(1));
        assert_eq!(current_reaction("Gỡ Thích", &picker), Some(0));
        assert_eq!(current_reaction("Gỡ Haha", &picker), Some(3));
        assert_eq!(current_reaction("Bày tỏ cảm xúc", &picker), None);
    }

    #[test]
    fn russian_reaction_labels() {
        // Labels seen on a Russian Facebook account (2026-11-14).
        let picker: Vec<String> = [
            "нравится",
            "супер",
            "мы вместе",
            "ха-ха",
            "ух ты!",
            "сочувствую",
            "возмутительно",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        assert_eq!(picker_name("Удалить реакцию \"Нравится\""), "нравится");
        assert_eq!(picker_name("Удалить реакцию «Нравится»"), "нравится");
        assert_eq!(picker_name("Ух ты!"), "ух ты!");
        let neutral = "Поставить Нравится публикации Анна Петрова";
        assert!(reaction_neutral(neutral, &picker));
        assert!(!reaction_landed(neutral, &picker, 0));
        for (i, name) in [
            "Нравится",
            "Супер",
            "Мы вместе",
            "Ха-ха",
            "Ух ты!",
            "Сочувствую",
            "Возмутительно",
        ]
        .iter()
        .enumerate()
        {
            let label = format!("Удалить {name} из публикации Иван Иванов");
            assert!(!reaction_neutral(&label, &picker), "{label}");
            assert!(reaction_landed(&label, &picker, i), "{label}");
        }
    }

    #[test]
    fn french_reaction_labels() {
        // Labels seen on a French Facebook account; the picker gives the names.
        let picker: Vec<String> = [
            "j’aime",
            "j’adore",
            "solidaire",
            "haha",
            "wouah",
            "triste",
            "grrr",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        assert!(reaction_neutral(
            "Réagir avec J’aime à la publication de Logic Nation",
            &picker
        ));
        assert!(reaction_neutral("J’aime, 28 réactions", &picker));
        assert!(!reaction_neutral(
            "Retirer J’adore de la publication de Logic Nation",
            &picker
        ));
        assert_eq!(
            current_reaction("Retirer J’adore de la publication de Logic Nation", &picker),
            Some(1)
        );
        assert_eq!(current_reaction("Supprimer Haha", &picker), Some(3));
        assert!(reaction_landed(
            "Retirer J’aime de la publication de X",
            &picker,
            0
        ));
        assert!(!reaction_landed(
            "Réagir avec J’aime à la publication de X",
            &picker,
            0
        ));
    }

    #[test]
    fn reaction_landed_requires_a_selected_state() {
        let picker: Vec<String> = ["like", "love", "haha"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        // Neutral button reads exactly "like": suffix-matches index 0 but
        // nothing is selected, so a missed click must not confirm.
        assert!(!reaction_landed("like", &picker, 0));
        assert!(!reaction_landed("like", &picker, 1));
        // Selected states name the reaction in its remove form.
        assert!(reaction_landed("remove like", &picker, 0));
        assert!(reaction_landed("remove love", &picker, 1));
        assert!(!reaction_landed("remove love", &picker, 0));
        assert!(!reaction_landed("remove haha", &picker, 1));
    }

    #[test]
    fn author_qualified_reactions_match_the_action_before_the_author() {
        let picker: Vec<String> = ["like", "love", "care", "haha", "wow", "sad", "angry"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let reported = "Remove Like from The Royal National College for the Blind (RNC)'s post";
        assert_eq!(current_reaction(reported, &picker), Some(0));
        assert!(reaction_landed(reported, &picker, 0));
        assert!(!reaction_neutral(reported, &picker));
        for (idx, reaction) in picker.iter().enumerate() {
            let label = format!("Remove {reaction} from Love Haha Angry's post");
            assert_eq!(current_reaction(&label, &picker), Some(idx), "{label}");
            assert!(!reaction_neutral(&label, &picker), "{label}");
            for requested in 0..picker.len() {
                assert_eq!(reaction_landed(&label, &picker, requested), idx == requested);
            }
        }
    }

    #[test]
    fn author_qualified_neutral_labels_do_not_confirm_a_reaction() {
        let picker: Vec<String> = ["like", "love", "care", "haha", "wow", "sad", "angry"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        for label in [
            "Like",
            "React with Like to Danielle Cools's post",
            "React with Like to Love Haha Angry's post",
            "React with Like to Love",
            "Like Love Haha Angry's post",
        ] {
            assert!(reaction_neutral(label, &picker), "{label}");
            for idx in 0..picker.len() {
                assert!(!reaction_landed(label, &picker, idx), "{label}: {idx}");
            }
        }
        for label in ["", "loading", "React to Danielle Cools's post"] {
            assert!(!reaction_neutral(label, &picker), "{label}");
        }
        // German selected Like begins with the neutral word: it stays selected
        let german: Vec<String> = ["gefällt mir", "love"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert!(!reaction_neutral("Gefällt mir nicht mehr", &german));
        assert!(reaction_neutral("Gefällt mir", &german));
        assert!(reaction_neutral("Like Ann\u{2019}s post", &picker));
        assert!(!reaction_neutral("Like Ann", &picker));
        assert!(!reaction_neutral("Like", &[]));
        assert!(!reaction_neutral("Like", &[String::new()]));
    }
}
