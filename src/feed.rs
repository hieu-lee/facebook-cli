use crate::browser::{Browser, Tab};
use crate::cdp::Res;
use crate::daemon::{Daemon, Out};
use crate::messenger::one_line;
use crate::ops::Args;
use serde_json::Value;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{Mutex, Notify, oneshot};

#[derive(Clone, Debug, Default)]
pub struct Post {
    pub author: String,
    /// The author's profile path (/vanity or /profile.php?id=), when the card
    /// linked one. Group posts merge the group name into `author`, so the
    /// name alone cannot resolve the person; this path can.
    pub author_ref: String,
    pub time: String,
    pub stats: String,
    pub text: String,
    pub url: String,
    pub ad: bool,
    pub reaction_label: String,
    pub reaction_pressed: Option<bool>,
}

fn format_post(d: &Daemon, p: &Post, urls: bool) -> String {
    let text = one_line(&p.text);
    let id = if p.url.is_empty() {
        "-".to_string()
    } else if urls {
        p.url.clone()
    } else {
        d.refs.put('p', &p.url)
    };
    let ad = if p.ad { " [ad]" } else { "" };
    format!(
        "{}{}{id}\t{}{ad}\t{}\t{}\t{text}",
        reaction_prefix(p),
        author_ref_prefix(&p.author_ref),
        one_line(&p.author),
        one_line(&p.time),
        p.stats
    )
}

fn reaction_prefix(p: &Post) -> String {
    if p.reaction_label.is_empty() { return String::new(); }
    let pressed = p.reaction_pressed.map(|value| value.to_string()).unwrap_or_default();
    format!("ru\t{}\t{pressed}\n", one_line(&p.reaction_label))
}

/// The line that carries a post's author profile path, printed before the
/// post line itself (the same prefix-line shape as a comment's `cu` line).
fn author_ref_prefix(author_ref: &str) -> String {
    if author_ref.is_empty() {
        String::new()
    } else {
        format!("au\t{}\n", one_line(author_ref))
    }
}

/// A wedged Chrome call must end the pump (so the next `fb feed` can start a new one), not hang it.
async fn bounded<T>(secs: u64, f: impl std::future::Future<Output = Res<T>>) -> Res<T> {
    tokio::time::timeout(Duration::from_secs(secs), f)
        .await
        .map_err(|_| "feed page stopped responding".to_string())?
}

async fn wait_main(b: &Browser, t: &Tab) -> Res<()> {
    let t0 = Instant::now();
    while b.eval(t, "!!document.querySelector('[role=main]')").await? != Value::Bool(true) {
        if t0.elapsed() > Duration::from_secs(15) {
            return Err("page did not load (logged out? run `fb login`)".into());
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Ok(())
}

/// Posts that newly appeared on screen. Most arrive with the permalink focus revealed; the rest
/// resolve via a trusted hover (the page script ends a batch with at most one of those, so its
/// hover coordinates stay valid).
async fn step(b: &Browser, t: &Tab) -> Res<Vec<Post>> {
    let mut out = Vec::new();
    loop {
        let raw = b.eval(t, "window.__fbFeed.step()").await?;
        let batch = raw.as_array().cloned().unwrap_or_default();
        if batch.is_empty() {
            return Ok(out);
        }
        for p in batch {
            if let Some(post) = resolve(b, t, &p).await? {
                // A post with no permalink (sponsored and suggested cards
                // usually have none) can never be opened, reacted to or
                // commented on — every action keys off the ref — so it
                // does not belong in the listing (BlindFB #21).
                if !post.url.is_empty() {
                    out.push(post);
                }
            } else {
                return Ok(out);
            }
        }
    }
}

/// `None` when the hovered card changed under the pointer; the page script retries it next step.
async fn resolve(b: &Browser, t: &Tab, p: &Value) -> Res<Option<Post>> {
    let mut url = p["url"].as_str().unwrap_or("").to_string();
    if let Some(h) = p["hover"].as_array()
        && let (Some(x), Some(y)) = (h[0].as_f64(), h[1].as_f64())
    {
        b.hover(t, x, y).await?;
        tokio::time::sleep(Duration::from_millis(30)).await;
        let r = b
            .eval(t, &format!("window.__fbFeed.href({x},{y},{})", p["pos"]))
            .await?;
        if r.is_null() {
            return Ok(None);
        }
        url = r.as_str().unwrap_or("").to_string();
    }
    if !crate::ops::is_post_path(&url) {
        url = p["alt"].as_str().unwrap_or("").to_string();
    }
    if !crate::ops::is_post_path(&url) {
        url.clear();
    }
    let s = |k: &str| p[k].as_str().unwrap_or("").to_string();
    Ok(Some(Post {
        author: s("author"),
        reaction_label: s("reaction_label"),
        reaction_pressed: p["reaction_pressed"].as_bool(),
        author_ref: s("aref"),
        time: s("time"),
        stats: format!(
            "{}/{}/{}",
            p["r"].as_str().unwrap_or("0"),
            p["c"].as_str().unwrap_or("0"),
            p["s"].as_str().unwrap_or("0")
        ),
        text: s("text"),
        url,
        ad: p["ad"] == Value::Bool(true),
    }))
}

/// One-shot scroll of any page whose posts use the feed layout (profiles, pages, groups).
async fn collect(d: &Daemon, b: &Browser, t: &Tab, url: &str, args: &Args, out: &Out) -> Res<()> {
    let (n, urls) = (args.n.unwrap_or(10), args.flag("urls"));
    b.goto(t, url).await?;
    wait_main(b, t).await?;
    let t0 = Instant::now();
    let mut count = 0;
    let mut seen_urls = std::collections::HashSet::new();
    let mut last = Instant::now();
    // End of the rendered list: window pinned to the bottom with a stable
    // height while steps come back empty. A short profile or group used to
    // pay the full 12 s no-post stall; a page still growing (lazy load in
    // flight changes the height) or not yet at its bottom keeps the stall.
    let mut end_h: Option<i64> = None;
    let mut end_since: Option<Instant> = None;
    while count < n
        && last.elapsed() < Duration::from_secs(12)
        && t0.elapsed() < Duration::from_secs(90)
    {
        let posts = step(b, t).await?;
        if !posts.is_empty() {
            last = Instant::now();
            end_h = None;
            end_since = None;
        } else if let Ok(end) = b.eval(t, "window.__fbFeed.atEnd()").await {
            let h = end["h"].as_i64().unwrap_or(-1);
            // Settled time only counts while nothing is loading: while a
            // fetch is in flight the height has not moved YET, and counting
            // it truncated pages whose next posts were seconds out (a slow
            // pagination response reads exactly like the end of the page).
            let loading = end["loading"] == Value::Bool(true);
            if !loading && end["bottom"] == Value::Bool(true) && end_h == Some(h) {
                if end_since.is_some_and(|s| s.elapsed() > Duration::from_millis(2500)) {
                    break;
                }
            } else {
                end_h = Some(h);
                end_since = Some(Instant::now());
            }
        }
        for p in posts
            .into_iter()
            .filter(|p| seen_urls.insert(p.url.clone()))
            .take(n - count)
        {
            count += 1;
            out.line(format_post(d, &p, urls));
        }
        b.eval(t, "window.__fbFeed.scroll()").await?;
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
    Ok(())
}

async fn collect_url(d: &Daemon, b: &Arc<Browser>, url: &str, args: &Args, out: &Out) -> Res<()> {
    let t = b.acquire().await?;
    let r = collect(d, b, &t, url, args, out).await;
    b.release(t).await;
    r
}

pub async fn posts(d: &Daemon, args: &[String], out: &Out) -> Res<()> {
    let a = crate::ops::parse(args, &[], &["full", "urls"])?;
    let b = d.browser(out).await?;
    let who = a.pos.first().map(String::as_str).unwrap_or("me");
    let p = crate::ops::profile_path(d, &b, who).await?;
    collect_url(d, &b, &format!("https://www.facebook.com{p}"), &a, out).await
}

/// The saved posts on facebook.com/saved: the same story cards the feed
/// reads, with the same row shape as `posts` (ref, author, time, counts,
/// text), so everything that works on a post works on these rows.
pub async fn saved(d: &Daemon, args: &[String], out: &Out) -> Res<()> {
    let a = crate::ops::parse(args, &[], &["full", "urls"])?;
    let b = d.browser(out).await?;
    collect_url(d, &b, "https://www.facebook.com/saved", &a, out).await
}

/// Home feed read-ahead: a background tab keeps scrolling so `fb feed` can answer from memory.
#[derive(Default)]
pub struct FeedBuf {
    inner: Mutex<Inner>,
    wake: Notify,
}

#[derive(Default)]
struct Inner {
    posts: Vec<Post>,
    cursor: usize,
    running: bool,
    /// the browser handle of the latest `fb feed` call (a crashed one is replaced on reconnect)
    browser: Option<Arc<Browser>>,
    /// a refresh arrived while a pump was running; the pump respawns itself on exit
    restart: bool,
    /// how many unread posts the current `fb feed` call is waiting for
    want: usize,
    epoch: u64,
    started: Option<Instant>,
    error: Option<String>,
    /// page scripts `fb post-menu` runs in this tab, where the listed posts' cards live
    actions: Vec<(String, oneshot::Sender<Res<Value>>)>,
}

/// Read-ahead beyond what callers asked for. Small on purpose: Facebook keeps only the last
/// 10-25 posts of a scrolled feed mounted, and post-menu needs the cards of the posts being
/// read still there.
const AHEAD: usize = 5;
const STALE: Duration = Duration::from_secs(20 * 60);

impl FeedBuf {
    async fn pump(self: Arc<Self>, mut epoch: u64) {
        loop {
            let Some(b) = self.inner.lock().await.browser.clone() else {
                break;
            };
            let r = self.pump_inner(&b, epoch).await;
            let mut g = self.inner.lock().await;
            if g.restart {
                // `--refresh` arrived while this pump was running: continue as the fresh pump (never two at once)
                g.restart = false;
                g.error = None;
                epoch = g.epoch;
                continue;
            }
            g.running = false;
            // no producer is left to run queued menu actions: answer them now, not at their deadline
            for (_, done) in g.actions.drain(..) {
                let _ = done.send(Err("the feed tab closed before this ran; nothing was pressed".into()));
            }
            if g.epoch == epoch
                && let Err(e) = r
            {
                g.error = Some(e);
            }
            break;
        }
        self.wake.notify_waiters();
    }

    async fn pump_inner(&self, b: &Arc<Browser>, epoch: u64) -> Res<()> {
        if self.inner.lock().await.epoch != epoch {
            return Ok(());
        }
        let t = bounded(60, b.new_tab(None)).await?;
        let open = || {
            bounded(60, async {
                b.goto(&t, "https://www.facebook.com/").await?;
                wait_main(b, &t).await
            })
        };
        let r = async {
            open().await?;
            let mut last = Instant::now();
            let mut reloads = 0;
            let mut nudged = Instant::now();
            let mut seen_urls = std::collections::HashSet::new();
            let mut frozen = false;
            loop {
                let notified = self.wake.notified();
                tokio::pin!(notified);
                notified.as_mut().enable();
                {
                    let mut g = self.inner.lock().await;
                    if g.epoch != epoch {
                        return Ok(());
                    }
                    // oldest first; one whose caller gave up (timed out) is dropped, never run late
                    g.actions.retain(|(_, done)| !done.is_closed());
                    if !g.actions.is_empty() {
                        let (expr, mut done) = g.actions.remove(0);
                        drop(g);
                        if frozen {
                            b.set_lifecycle(&t, false).await;
                            frozen = false;
                        }
                        // a caller that gives up mid-walk (its timeout) stops the remaining presses
                        let r = tokio::select! {
                            r = bounded(90, b.eval(&t, &expr)) => Some(r),
                            _ = done.closed() => None,
                        };
                        // gave up or hit the 90 s bound: the page script still runs, so stop it there
                        if !matches!(r, Some(Ok(_))) {
                            let _ = bounded(10, b.eval(&t, "window.__fbFeed.stop()")).await;
                        }
                        close_layers(b, &t).await;
                        if let Some(r) = r {
                            let _ = done.send(r);
                        }
                        last = Instant::now();
                        continue;
                    }
                    if g.posts.len() - g.cursor >= AHEAD.max(g.want) {
                        drop(g);
                        // Parked at the read-ahead limit: freeze the page so
                        // the buffered tab costs no CPU while it waits. The
                        // wake below is Rust-side and still fires; stepping
                        // unfreezes first, so a refill is never slowed.
                        if !frozen {
                            b.set_lifecycle(&t, true).await;
                            frozen = true;
                        }
                        let _ = tokio::time::timeout(Duration::from_secs(30), notified).await;
                        last = Instant::now();
                        continue;
                    }
                }
                if frozen {
                    b.set_lifecycle(&t, false).await;
                    frozen = false;
                }
                let posts: Vec<_> = bounded(45, step(b, &t))
                    .await?
                    .into_iter()
                    .filter(|p| p.url.is_empty() || seen_urls.insert(p.url.clone()))
                    .collect();
                if !posts.is_empty() {
                    last = Instant::now();
                    reloads = 0;
                    let mut g = self.inner.lock().await;
                    if g.epoch != epoch {
                        return Ok(());
                    }
                    g.posts.extend(posts);
                    drop(g);
                    self.wake.notify_waiters();
                } else if last.elapsed() > Duration::from_secs(12) {
                    // Nudging did not help; a fresh load has more posts (seen_urls drops the repeats),
                    // so only quit when reloading stops helping too.
                    if reloads == 2 {
                        return Err("feed stopped loading".into());
                    }
                    reloads += 1;
                    open().await?;
                    last = Instant::now();
                    continue;
                } else if last.elapsed() > Duration::from_secs(3)
                    && nudged.elapsed() > Duration::from_secs(3)
                {
                    // Facebook sometimes stops adding posts at the bottom of the page
                    bounded(10, b.eval(&t, "window.__fbFeed.nudge()")).await?;
                    nudged = Instant::now();
                }
                bounded(10, b.eval(&t, "window.__fbFeed.scroll()")).await?;
                tokio::time::sleep(Duration::from_millis(150)).await;
            }
        }
        .await;
        let _ = tokio::time::timeout(Duration::from_secs(5), b.close(t)).await;
        r
    }

    /// Drop buffered posts (they belong to the previous account); a running pump restarts on the next call.
    pub async fn clear(&self) {
        let mut g = self.inner.lock().await;
        g.epoch += 1;
        g.posts.clear();
        g.cursor = 0;
        g.started = None;
        if g.running {
            g.restart = true; // the running pump hands over to a fresh one for the new epoch
        }
        drop(g);
        self.wake.notify_waiters();
    }

    pub async fn start(self: &Arc<Self>, b: &Arc<Browser>, reset: bool) {
        let mut g = self.inner.lock().await;
        // a replaced browser (Chrome crashed and reconnected) invalidates the running pump too
        let browser_changed = g.browser.as_ref().is_some_and(|old| !Arc::ptr_eq(old, b));
        g.browser = Some(b.clone());
        let stale = g.started.map(|s| s.elapsed() > STALE).unwrap_or(false);
        if reset || stale || browser_changed {
            g.epoch += 1;
            g.posts.clear();
            g.cursor = 0;
            g.error = None;
            g.started = Some(Instant::now());
            if g.running {
                g.restart = true;
                drop(g);
                self.wake.notify_waiters();
                return;
            }
        }
        if !g.running {
            g.running = true;
            g.error = None;
            g.started.get_or_insert_with(Instant::now);
            let epoch = g.epoch;
            tokio::spawn(self.clone().pump(epoch));
        }
    }

    /// Run `expr` in the feed tab between pump steps; `None` when no feed tab is open.
    async fn act(&self, expr: String) -> Option<Res<Value>> {
        let (done, rx) = oneshot::channel();
        {
            let mut g = self.inner.lock().await;
            if !g.running {
                return None;
            }
            g.actions.push((expr, done));
        }
        self.wake.notify_waiters();
        // past the deadline the walk may already have pressed something: report that, never let
        // the caller replay the presses on the post page (dropping rx stops the rest of the walk)
        match tokio::time::timeout(Duration::from_secs(120), rx).await {
            Ok(Ok(r)) => Some(r),
            _ => Some(Err("the feed tab did not finish within 120 s; some presses may have happened, check the post before trying again"
                .into())),
        }
    }

    async fn take(&self, n: usize) -> Res<Vec<Post>> {
        let deadline = Instant::now() + Duration::from_secs(60);
        loop {
            let notified = self.wake.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            {
                let mut g = self.inner.lock().await;
                let have = g.posts.len() - g.cursor;
                if g.want < n {
                    g.want = n;
                    self.wake.notify_waiters(); // the producer may be parked at its read-ahead limit
                }
                if have >= n || (!g.running && have > 0) || Instant::now() > deadline {
                    let end = (g.cursor + n).min(g.posts.len());
                    let out = g.posts[g.cursor..end].to_vec();
                    g.cursor = end;
                    g.want = 0;
                    if g.cursor >= 100 {
                        // consumed posts are never read again
                        let c = g.cursor;
                        g.posts.drain(..c);
                        g.cursor = 0;
                    }
                    drop(g);
                    self.wake.notify_waiters();
                    return Ok(out);
                }
                if !g.running {
                    return Err(g.error.clone().unwrap_or_else(|| "feed unavailable".into()));
                }
            }
            let _ = tokio::time::timeout(Duration::from_secs(2), notified).await;
        }
    }
}

/// `fb feed`: the next `n` posts. Repeated calls keep scrolling; `--refresh` starts over.
pub async fn feed(d: &Daemon, args: &[String], out: &Out) -> Res<()> {
    let a = crate::ops::parse(args, &[], &["refresh", "full", "urls"])?;
    let b = d.browser(out).await?;
    d.feed.start(&b, a.flag("refresh")).await;
    let urls = a.flag("urls");
    for p in d.feed.take(a.n.unwrap_or(10)).await? {
        out.line(format_post(d, &p, urls));
    }
    Ok(())
}

const CANCELLED: &str = "cancelled by client; presses after that point were not made";

/// Resolves once the client went away (Ctrl-C, its timeout, a closed connection).
async fn client_gone(out: &Out) {
    while !out.cancelled() {
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

/// Close whatever menus and dialogs post-menu left open (Escape needs trusted key presses).
async fn close_layers(b: &Browser, t: &Tab) {
    for _ in 0..3 {
        // bounded: a key event Chrome never answers must not wedge the feed pump
        let _ = tokio::time::timeout(Duration::from_secs(5), b.key(t, "Escape", "Escape", 27, 0)).await;
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
}

/// `fb post-menu <post> [--press <label>]...`: a post's "Actions for this post" menu. Each
/// `--press` presses that label in what the previous press showed (a submenu, a dialog such as
/// Report), and the output describes what shows after the last one. A post `fb feed` listed is
/// worked on its feed card, the only place Facebook offers Interested / Not interested; any
/// other post, or one whose card Facebook has dropped, on the post's own page.
pub async fn post_menu(d: &Daemon, args: &[String], out: &Out) -> Res<()> {
    let a = crate::ops::parse(args, &["press"], &[])?;
    let spec = a.pos.first().ok_or("usage: post-menu <post> [--press <label>]...")?;
    // a post only: on a profile or page the fallback would press the first post's menu there
    let url = crate::ops::resolve_post_strict(d, spec).await?;
    let path = Value::from(a.opts_all("press"));
    let b = d.browser(out).await?;
    let gen0 = b.generation.load(std::sync::atomic::Ordering::SeqCst);
    // a press can change the account (hide, snooze, report): hold it like other mutations
    let _account = d.account.read().await;
    if b.generation.load(std::sync::atomic::Ordering::SeqCst) != gen0 {
        return Err(
            "the account changed while this command waited; nothing was done, try again".into(),
        );
    }
    let card = format!("window.__fbFeed.menu({},{path})", Value::from(url.as_str()));
    let feed = tokio::select! {
        r = d.feed.act(card) => r,
        // dropping the action's receiver makes the feed tab stop the walk before its next press
        _ = client_gone(out) => return Err(CANCELLED.into()),
    };
    let (from, r) = match feed {
        Some(Ok(r)) if r["gone"] != Value::Bool(true) => ("feed", r),
        Some(Err(e)) => return Err(e),
        card => {
            // why the feed card was not used, for the caller to explain the shorter menu
            let why = match &card {
                Some(Ok(r)) => r["why"].as_str().unwrap_or("").to_string(),
                _ => "no feed is open".to_string(),
            };
            out.line(format!("feedcard\t{}", one_line(&why)));
            let page = if url.starts_with('/') {
                format!("https://www.facebook.com{url}")
            } else {
                url.clone()
            };
            let t = b.acquire().await?;
            let r = async {
                b.goto(&t, &page).await?;
                wait_main(&b, &t).await?;
                let walk = format!("window.__fbFeed.postMenu({path},{})", Value::from(page.as_str()));
                let r = tokio::select! {
                    r = bounded(90, b.eval(&t, &walk)) => r,
                    _ = client_gone(out) => Err(CANCELLED.into()),
                };
                // a cancelled or timed-out walk is still running in the page: stop it there
                if r.is_err() {
                    let _ = bounded(10, b.eval(&t, "window.__fbFeed.stop()")).await;
                }
                r
            }
            .await;
            close_layers(&b, &t).await;
            b.release(t).await;
            ("post", r?)
        }
    };
    if let Some(e) = r["err"].as_str() {
        return Err(e.to_string());
    }
    out.line(format!("from\t{from}"));
    let s = |v: &Value| one_line(v.as_str().unwrap_or(""));
    if r["done"] == Value::Bool(true) {
        out.line("done");
    } else {
        out.line(format!("title\t{}", s(&r["title"])));
        for line in r["text"].as_array().into_iter().flatten() {
            out.line(format!("text\t{}", s(line)));
        }
        for o in r["options"].as_array().into_iter().flatten() {
            let on = if o[2] == Value::Bool(true) { "on" } else { "" };
            out.line(format!("option\t{}\t{}\t{on}", s(&o[0]), s(&o[1])));
        }
    }
    for note in r["notes"].as_array().into_iter().flatten() {
        out.line(format!("note\t{}", s(note)));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::author_ref_prefix;

    #[test]
    fn author_ref_prefix_carries_the_profile_path() {
        assert_eq!(
            author_ref_prefix("/profile.php?id=456"),
            "au\t/profile.php?id=456\n"
        );
        assert_eq!(author_ref_prefix("/some.user"), "au\t/some.user\n");
    }

    #[test]
    fn own_reaction_metadata_precedes_its_post() {
        let p = Post { reaction_label: "Remove Love".into(), reaction_pressed: Some(true), ..Post::default() };
        assert_eq!(reaction_prefix(&p), "ru\tRemove Love\ttrue\n");
        assert_eq!(reaction_prefix(&Post::default()), "");
    }

    #[test]
    fn author_ref_prefix_is_empty_without_a_ref() {
        assert_eq!(author_ref_prefix(""), "");
    }
}
