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

pub fn file_arg(path: &str, cwd: &str) -> Res<(String, &'static str, Vec<u8>)> {
    let full = crate::proto::resolve_path(cwd, path);
    let bytes = std::fs::read(&full).map_err(|e| format!("{full}: {e}"))?;
    let name = std::path::Path::new(&full)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("file")
        .to_string();
    let mime = mime_of(&name);
    Ok((name, mime, bytes))
}

pub(crate) async fn attach_files(
    b: &Browser,
    t: &Tab,
    files: &[(String, &'static str, Vec<u8>)],
) -> Res<()> {
    for (name, mime, bytes) in files {
        crate::messenger::upload(b, t, bytes).await?;
        ok(&b
            .eval(
                t,
                &format!(
                    "window.__fb.composeAttach({},{})",
                    json!(name),
                    json!(mime)
                ),
            )
            .await?)?;
    }
    Ok(())
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
    let a = parse(args, &["img", "to"], &["dry"])?;
    let text = a.pos.join(" ");
    let imgs = a.opts_all("img");
    if text.is_empty() && imgs.is_empty() {
        return Err("usage: post <text> [--img file]... [--to public|friends|me]".into());
    }
    let audience = a.opt("to").map(|s| match s {
        "public" | "friends" | "me" => Ok(s.to_string()),
        _ => Err("--to must be public|friends|me".to_string()),
    });
    let audience = audience.transpose()?;
    let files: Vec<_> = imgs.iter().map(|p| file_arg(p, cwd)).collect::<Res<_>>()?;
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
        let profile = crate::ops::profile_path(d, &b, "me").await?;
        b.goto(&t, &format!("https://www.facebook.com{profile}")).await?;
        ok(&b.eval(&t, "window.__fb.composeOpen()").await?)?;
        if !text.is_empty() {
            type_into(&b, &t, &text).await?;
        }
        attach_files(&b, &t, &files).await?;
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
        ok(&b.eval(&t, "window.__fb.composePrepare()").await?)?;
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
        let receipt = async {
            ok(&b.eval(&t, "window.__fb.composePress()").await?)?;
            let path = tokio::time::timeout(Duration::from_secs(15), created_post(&b, &t, &uid, &mut events)).await.map_err(|_| "creation response timed out".to_string())??;
            b.goto(&t, &format!("https://www.facebook.com{path}")).await?;
            let readback = b.eval(&t, &format!("window.__fb.waitFor(()=>{{window.__fbFeed.expand();const r=window.__fb.postRoot();return r&&window.__fb.postText(r.querySelector('[data-ad-rendering-role=story_message]'))===window.__fb.clean({})}},15000)", json!(text))).await?;
            if readback != Value::Bool(true) { return Err("created post content could not be read back".into()); }
            Ok(path)
        }.await;
        let _ = b.cdp.call(Some(&t.session), "Network.disable", json!({})).await;
        let path = receipt.map_err(|e: String| format!("post may have been published, but no verified receipt: {e}; inspect `fb posts me` before retrying"))?;
        out.line(format!("posted\t{}\t{path}", d.refs.put('p', &path)));

        Ok(())
    }
    .await;
    b.release(t).await;
    r
}

async fn created_post(
    b: &Browser,
    t: &Tab,
    uid: &str,
    events: &mut tokio::sync::broadcast::Receiver<crate::cdp::Event>,
) -> Res<String> {
    let mut request: Option<String> = None;
    loop {
        let event = events
            .recv()
            .await
            .map_err(|_| "creation events lost".to_string())?;
        if event.session.as_deref() != Some(&t.session) {
            continue;
        }
        let p = &event.params;
        let id = p["requestId"].as_str().unwrap_or("");
        if event.method == "Network.requestWillBeSent"
            && p["request"]["method"] == "POST"
            && crate::ops::fb_path(p["request"]["url"].as_str().unwrap_or(""))
                .is_some_and(|p| p.starts_with("/api/graphql/"))
            && p["request"]["postData"].as_str().is_some_and(|s| {
                s.split('&')
                    .any(|v| v == "fb_api_req_friendly_name=ComposerStoryCreateMutation")
            })
        {
            if request.as_deref().is_some_and(|old| old != id) {
                return Err("multiple creation requests".into());
            }
            request = Some(id.to_string());
        }
        if request.as_deref() != Some(id) {
            continue;
        }
        if event.method == "Network.loadingFailed" {
            return Err("creation request failed".into());
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
        let mut paths = std::collections::HashSet::new();
        for line in body
            .trim_start()
            .strip_prefix("for (;;);")
            .unwrap_or(body)
            .lines()
            .filter(|l| !l.trim().is_empty())
        {
            let value: Value =
                serde_json::from_str(line).map_err(|_| "invalid creation response")?;
            if value["errors"].as_array().is_some_and(|e| !e.is_empty()) {
                return Err("Facebook rejected the creation request".into());
            }
            let story = &value["data"]["story_create"]["story"];
            if story.is_null() {
                continue;
            }
            if story["default_actor"]["id"].as_str() != Some(uid) {
                return Err("creation actor mismatch".into());
            }
            let path =
                crate::ops::fb_path(story["url"].as_str().ok_or("created story URL missing")?)
                    .filter(|p| crate::ops::is_post_path(p))
                    .ok_or("invalid created story URL")?;
            paths.insert(path);
        }
        if paths.len() != 1 {
            return Err("unique creation identity missing".into());
        }
        return Ok(paths.into_iter().next().unwrap());
    }
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

/// Which picker entry the button label ("Remove Love") names: the longest picker label it ends with
/// (in Vietnamese "Yêu thích" also ends with "thích", so the longest match wins).
fn current_reaction(label: &str, picker: &[String]) -> Option<usize> {
    let l = label.to_lowercase();
    picker
        .iter()
        .enumerate()
        .filter(|(_, p)| !p.is_empty() && l.ends_with(p.as_str()))
        .max_by_key(|(_, p)| p.len())
        .map(|(i, _)| i)
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
        // The picker labels are the language-independent reference: the button reads exactly like
        // the first entry ("Like") when nothing is selected, and like "Remove <reaction>" otherwise.
        // the picker opens on hover after a short delay: retry, never guess "no reaction"
        let mut pick = Value::Null;
        for attempt in 0..4 {
            if attempt > 0 {
                b.hover(&t, x + 40.0, y + 60.0).await?;
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
            b.hover(&t, x, y).await?;
            tokio::time::sleep(Duration::from_millis(900)).await;
            pick = b
                .eval(&t, &format!("window.__fb.reactionPick({})", idx.min(6)))
                .await?;
            if pick["labels"].as_array().is_some_and(|l| !l.is_empty()) {
                break;
            }
        }
        let labels: Vec<String> = match pick["labels"].as_array() {
            Some(a) if !a.is_empty() => a
                .iter()
                .map(|l| l.as_str().unwrap_or("").to_lowercase())
                .collect(),
            _ => return Err("reaction picker did not open (nothing was changed)".into()),
        };
        let label = info["label"].as_str().unwrap_or("").to_lowercase();
        let liked = labels
            .first()
            .is_some_and(|first| !first.is_empty() && label != *first);
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
            }
        } else if current != Some(idx) {
            let (px, py) = (
                pick["x"].as_f64().ok_or("reaction picker not found")?,
                pick["y"].as_f64().ok_or("reaction picker not found")?,
            );
            b.click(&t, px, py).await?;
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
}
