use crate::browser::{Browser, Tab};
use crate::cdp::Res;
use crate::daemon::{Daemon, Out};
use crate::messenger::one_line;
use crate::ops::Args;
use serde_json::Value;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{Mutex, Notify};

#[derive(Clone, Debug, Default)]
pub struct Post {
    pub author: String,
    pub time: String,
    pub stats: String,
    pub text: String,
    pub url: String,
    pub ad: bool,
}

fn format_post(d: &Daemon, p: &Post, full: bool, urls: bool) -> String {
    let text = one_line(&p.text);
    let text = if full {
        text
    } else {
        crate::messenger::trunc(&text, 280)
    };
    let id = if p.url.is_empty() {
        "-".to_string()
    } else if urls {
        p.url.clone()
    } else {
        d.refs.put('p', &p.url)
    };
    let ad = if p.ad { " [ad]" } else { "" };
    format!(
        "{id}\t{}{ad}\t{}\t{}\t{text}",
        one_line(&p.author),
        one_line(&p.time),
        p.stats
    )
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

/// Posts that newly appeared on screen, each resolved to a permalink via a trusted hover
/// (the page script hands out one post at a time so its hover coordinates stay valid).
async fn step(b: &Browser, t: &Tab) -> Res<Vec<Post>> {
    let mut out = Vec::new();
    loop {
        let raw = b.eval(t, "window.__fbFeed.step()").await?;
        let Some(p) = raw.as_array().and_then(|a| a.first()).cloned() else {
            return Ok(out);
        };
        let mut url = String::new();
        if let Some(h) = p["hover"].as_array()
            && let (Some(x), Some(y)) = (h[0].as_f64(), h[1].as_f64())
        {
            b.hover(t, x, y).await?;
            tokio::time::sleep(Duration::from_millis(30)).await;
            let r = b
                .eval(t, &format!("window.__fbFeed.href({x},{y},{})", p["pos"]))
                .await?;
            if r.is_null() {
                return Ok(out);
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
        out.push(Post {
            author: s("author"),
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
        });
    }
}

/// One-shot scroll of any page whose posts use the feed layout (profiles, pages, groups).
async fn collect(d: &Daemon, b: &Browser, t: &Tab, url: &str, args: &Args, out: &Out) -> Res<()> {
    let (n, full, urls) = (args.n.unwrap_or(10), args.flag("full"), args.flag("urls"));
    b.goto(t, url).await?;
    wait_main(b, t).await?;
    let t0 = Instant::now();
    let mut count = 0;
    let mut seen_urls = std::collections::HashSet::new();
    let mut last = Instant::now();
    while count < n
        && last.elapsed() < Duration::from_secs(12)
        && t0.elapsed() < Duration::from_secs(90)
    {
        let posts = step(b, t).await?;
        if !posts.is_empty() {
            last = Instant::now();
        }
        for p in posts
            .into_iter()
            .filter(|p| p.url.is_empty() || seen_urls.insert(p.url.clone()))
            .take(n - count)
        {
            count += 1;
            out.line(format_post(d, &p, full, urls));
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
}

const AHEAD: usize = 25;
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
        let r = async {
            bounded(60, async {
                b.goto(&t, "https://www.facebook.com/").await?;
                wait_main(b, &t).await
            })
            .await?;
            let mut last = Instant::now();
            let mut seen_urls = std::collections::HashSet::new();
            loop {
                let notified = self.wake.notified();
                tokio::pin!(notified);
                notified.as_mut().enable();
                {
                    let g = self.inner.lock().await;
                    if g.epoch != epoch {
                        return Ok(());
                    }
                    if g.posts.len() - g.cursor >= AHEAD.max(g.want) {
                        drop(g);
                        let _ = tokio::time::timeout(Duration::from_secs(30), notified).await;
                        last = Instant::now();
                        continue;
                    }
                }
                let posts: Vec<_> = bounded(45, step(b, &t))
                    .await?
                    .into_iter()
                    .filter(|p| p.url.is_empty() || seen_urls.insert(p.url.clone()))
                    .collect();
                if !posts.is_empty() {
                    last = Instant::now();
                    let mut g = self.inner.lock().await;
                    if g.epoch != epoch {
                        return Ok(());
                    }
                    g.posts.extend(posts);
                    drop(g);
                    self.wake.notify_waiters();
                } else if last.elapsed() > Duration::from_secs(25) {
                    return Err("feed stopped loading".into());
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
    let (full, urls) = (a.flag("full"), a.flag("urls"));
    for p in d.feed.take(a.n.unwrap_or(10)).await? {
        out.line(format_post(d, &p, full, urls));
    }
    Ok(())
}
