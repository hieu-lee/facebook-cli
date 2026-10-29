use crate::browser::Browser;
use crate::cdp::Res;
use crate::daemon::{Daemon, Out};
use crate::page::RecordingFile;
use crate::stories::StoryGuard;
use futures_util::{StreamExt, stream};
use serde::Deserialize;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const MAX_MEDIA: u64 = 256 * 1024 * 1024;
const CONCURRENCY: usize = 4;
const MAX_RECOVERY_URLS: usize = 8;

#[derive(Deserialize)]
struct Item {
    story: usize,
    part: usize,
    kind: String,
    url: String,
}

#[derive(Deserialize)]
struct StoryItems {
    items: Vec<Item>,
    missing: Vec<usize>,
    more: bool,
}

#[derive(Deserialize)]
struct ProfileStory {
    owner: String,
    path: Option<String>,
}

struct StoryTarget {
    path: String,
    owner: Option<String>,
}

#[derive(Deserialize)]
struct PhotoBatch {
    items: Vec<PhotoItem>,
    #[serde(default)]
    updates: Vec<PhotoItem>,
    done: bool,
    complete: bool,
    missing: bool,
}

#[derive(Deserialize)]
struct PhotoItem {
    index: usize,
    id: String,
    url: Option<String>,
}

struct PhotoFallback {
    item: PhotoItem,
    error: Option<String>,
    attempted: Vec<String>,
}

fn arguments(args: &[String], default_limit: usize) -> Res<(String, Option<String>, usize, bool)> {
    let a = crate::ops::parse(args, &["out"], &["all"])?;
    if a.pos.len() != 1 || a.pos[0].trim().is_empty() {
        return Err("usage: stories|photos <account> [--out dir] [-n N | --all]".into());
    }
    if a.flag("all") && a.n.is_some() {
        return Err("use -n or --all, not both".into());
    }
    if a.opt("out").is_some_and(|s| s.contains(['\n', '\r', '\t'])) {
        return Err("invalid output directory".into());
    }
    let all = a.flag("all");
    let limit = if all && default_limit != 0 {
        1000
    } else {
        a.n.unwrap_or(default_limit)
    };
    if limit > 1000 {
        return Err("-n must be at most 1000".into());
    }
    Ok((
        a.pos[0].trim().to_owned(),
        a.opt("out").map(String::from),
        limit,
        all,
    ))
}

fn output_dir(cwd: &str, requested: Option<&str>, prefix: &str) -> Res<PathBuf> {
    let dir = match requested {
        Some("") => return Err("--out needs a directory".into()),
        Some(path) => PathBuf::from(crate::proto::resolve_path(cwd, path)),
        None => {
            static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
            let time = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|e| e.to_string())?
                .as_millis();
            let next = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            Path::new(cwd).join(format!("fb-{prefix}-{time}-{}-{next}", std::process::id()))
        }
    };
    if dir.to_str().is_none_or(|s| s.contains(['\n', '\r', '\t'])) {
        return Err("invalid output directory".into());
    }
    if let Ok(meta) = std::fs::symlink_metadata(&dir)
        && (!meta.is_dir() || meta.file_type().is_symlink())
    {
        return Err("output is not a directory".into());
    }
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(&dir).map_err(|e| e.to_string())?;
    static PROBE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let probe = dir.join(format!(
        ".fb-link-check-{}-{}",
        std::process::id(),
        PROBE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    let temp = RecordingFile::create(probe.to_str().ok_or("invalid output directory")?)?;
    temp.finish_new(|| Ok(()))
        .map_err(|_| "output directory requires hard-link support")?;
    std::fs::remove_file(probe).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn client() -> Res<reqwest::Client> {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    if let Some(client) = CLIENT.get() {
        return Ok(client.clone());
    }
    let client = client_builder()
        .build()
        .map_err(|_| "cannot initialize media downloader")?;
    let _ = CLIENT.set(client);
    Ok(CLIENT.get().unwrap().clone())
}

fn client_builder() -> reqwest::ClientBuilder {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(15))
        .read_timeout(Duration::from_secs(60))
        .user_agent("Mozilla/5.0")
}

fn media_url(url: &str) -> Res<reqwest::Url> {
    if url.len() > 8192 {
        return Err("invalid media URL".into());
    }
    let u = reqwest::Url::parse(url).map_err(|_| "invalid media URL")?;
    let host = u.host_str().ok_or("invalid media host")?;
    if u.scheme() != "https"
        || !u.username().is_empty()
        || u.password().is_some()
        || u.port().is_some_and(|p| p != 443)
        || !(host == "fbcdn.net" || host.ends_with(".fbcdn.net"))
    {
        return Err("unsupported media host".into());
    }
    Ok(u)
}

fn extension(content_type: &str, kind: &str) -> Res<&'static str> {
    match (kind, content_type.split(';').next().unwrap_or("").trim()) {
        ("Photo", "image/jpeg") => Ok("jpg"),
        ("Photo", "image/png") => Ok("png"),
        ("Photo", "image/webp") => Ok("webp"),
        ("Photo", "image/avif") => Ok("avif"),
        ("Photo", "image/gif") => Ok("gif"),
        ("Video", "video/mp4") => Ok("mp4"),
        ("Video", "video/webm") => Ok("webm"),
        ("Video", "video/quicktime") => Ok("mov"),
        _ => Err("unsupported media type".into()),
    }
}

async fn download(
    client: &reqwest::Client,
    item: &Item,
    dir: &Path,
    guard: &StoryGuard,
    out: &Out,
) -> Res<()> {
    let file = download_file(client, item, dir, || check(guard, out)).await?;
    out.line(file);
    Ok(())
}

async fn finish_downloads(
    pending: impl futures_util::Stream<Item = Res<()>>,
    check: impl Fn() -> Res<()>,
) -> Res<()> {
    futures_util::pin_mut!(pending);
    let mut failure = None;
    while let Some(result) = pending.next().await {
        if let Err(error) = result {
            check()?;
            failure.get_or_insert(error);
        }
    }
    failure.map_or(Ok(()), Err)
}

fn retry_photo(error: &str) -> bool {
    error.starts_with("media HTTP ")
        || matches!(
            error,
            "media request failed"
                | "media transfer failed"
                | "empty media"
                | "unsupported media type"
        )
}

fn recoverable_photo(error: &str) -> bool {
    retry_photo(error)
        || matches!(
            error,
            "invalid media URL" | "unsupported media host" | "photo not available"
        )
}

async fn until_cancelled<T>(
    future: impl std::future::Future<Output = Res<T>>,
    check: impl Fn() -> Res<()>,
) -> Res<T> {
    tokio::pin!(future);
    let mut tick = tokio::time::interval(Duration::from_millis(200));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            result = &mut future => return result,
            _ = tick.tick() => check()?,
        }
    }
}

async fn download_file(
    client: &reqwest::Client,
    item: &Item,
    dir: &Path,
    check: impl Fn() -> Res<()> + Sync,
) -> Res<String> {
    check()?;
    let url = media_url(&item.url)?;
    let response = client
        .get(url)
        .header(reqwest::header::REFERER, "https://www.facebook.com/")
        .send()
        .await
        .map_err(|_| "media request failed")?;
    if response.status() != reqwest::StatusCode::OK {
        return Err(format!("media HTTP {}", response.status().as_u16()));
    }
    if response.content_length().is_some_and(|n| n > MAX_MEDIA) {
        return Err("media too large".into());
    }
    let mime = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let ext = extension(mime, &item.kind)?;
    let file = if item.part == 1 {
        format!("{}.{ext}", item.story)
    } else {
        format!("{}-{}.{ext}", item.story, item.part)
    };
    let path = dir.join(&file).to_string_lossy().into_owned();
    match tokio::fs::symlink_metadata(&path).await {
        Ok(_) => return Err("destination already exists".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.to_string()),
    }
    let target = tokio::task::spawn_blocking(move || RecordingFile::create(&path))
        .await
        .map_err(|e| e.to_string())??;
    let target = write_body(response, target, &check).await?;
    tokio::task::block_in_place(|| target.finish_new(check))?;
    Ok(file)
}

async fn write_body(
    response: reqwest::Response,
    mut target: RecordingFile,
    check: impl Fn() -> Res<()>,
) -> Res<RecordingFile> {
    let mut size = 0u64;
    const CHUNK: usize = 1024 * 1024;
    let mut buffer = Vec::with_capacity(CHUNK);
    let mut chunks = response.bytes_stream();
    while let Some(chunk) = chunks.next().await {
        check()?;
        let chunk = chunk.map_err(|_| "media transfer failed")?;
        size = size
            .checked_add(chunk.len() as u64)
            .ok_or("media too large")?;
        if size > MAX_MEDIA {
            return Err("media too large".into());
        }
        for part in chunk.chunks(CHUNK) {
            buffer.extend_from_slice(part);
            if buffer.len() >= CHUNK {
                target = tokio::task::spawn_blocking(move || {
                    target.write(&buffer)?;
                    Ok::<_, String>(target)
                })
                .await
                .map_err(|e| e.to_string())??;
                buffer = Vec::with_capacity(CHUNK);
            }
        }
    }
    if size == 0 {
        return Err("empty media".into());
    }
    if !buffer.is_empty() {
        target = tokio::task::spawn_blocking(move || {
            target.write(&buffer)?;
            Ok::<_, String>(target)
        })
        .await
        .map_err(|e| e.to_string())??;
    }
    let target = tokio::task::spawn_blocking(move || {
        target.sync()?;
        Ok::<_, String>(target)
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(target)
}

async fn guarded_tab(
    b: &Arc<Browser>,
    photos: bool,
    out: &Out,
) -> Res<(crate::browser::Tab, StoryGuard)> {
    let tab = until_cancelled(b.acquire_story_tab(), || check_client(out)).await?;
    let guard = until_cancelled(
        async {
            tokio::time::timeout(Duration::from_secs(10), async {
                if photos {
                    crate::stories::protect_photos(b, &tab).await
                } else {
                    crate::stories::protect(b, &tab).await
                }
            })
            .await
            .map_err(|_| "protecting session timed out")?
        },
        || check_client(out),
    )
    .await?;
    Ok((tab, guard))
}

fn check_client(out: &Out) -> Res<()> {
    if out.cancelled() {
        Err("cancelled".into())
    } else {
        Ok(())
    }
}

fn check(guard: &StoryGuard, out: &Out) -> Res<()> {
    if guard.finished() || out.cancelled() {
        Err("story protection stopped or cancelled".into())
    } else {
        Ok(())
    }
}

fn profile_target(path: String) -> Res<String> {
    let pathname = path.split(['?', '#']).next().unwrap_or("");
    if pathname.is_empty()
        || pathname == "/"
        || matches!(pathname, "/photo" | "/photo/" | "/photo.php")
        || pathname == "/stories"
        || pathname.starts_with("/stories/")
        || crate::ops::is_post_path(&path)
        || pathname.split('/').any(crate::ops::is_dot_segment)
    {
        return Err("need a profile URL or ref".into());
    }
    Ok(path)
}

fn photos_url(profile: &str) -> Res<String> {
    let pathname = profile.split(['?', '#']).next().unwrap_or("");
    if pathname == "/profile.php" {
        let url = reqwest::Url::parse(&format!("https://www.facebook.com{profile}"))
            .map_err(|_| "invalid profile URL")?;
        let ids: Vec<_> = url
            .query_pairs()
            .filter(|(key, _)| key == "id")
            .map(|(_, value)| value.into_owned())
            .collect();
        if ids.len() != 1 || ids[0].is_empty() || !ids[0].bytes().all(|c| c.is_ascii_digit()) {
            return Err("invalid profile ID".into());
        }
        Ok(format!(
            "https://www.facebook.com/profile.php?id={}&sk=photos",
            ids[0]
        ))
    } else {
        let path = pathname.trim_end_matches('/');
        Ok(if path.ends_with("/photos") {
            format!("https://www.facebook.com{path}")
        } else {
            format!("https://www.facebook.com{path}/photos")
        })
    }
}

async fn story_path(
    d: &Daemon,
    b: &Arc<Browser>,
    tab: &crate::browser::Tab,
    who: &str,
    guard: &StoryGuard,
    out: &Out,
) -> Res<StoryTarget> {
    if let Some(path) = crate::ops::fb_path(who)
        && path.starts_with("/stories/")
    {
        return Ok(StoryTarget { path, owner: None });
    }
    let profile = profile_target(crate::ops::profile_path_explicit(d, b, who).await?)?;
    check(guard, out)?;
    b.goto(tab, &format!("https://www.facebook.com{profile}"))
        .await?;
    let value = b
        .eval(
            tab,
            &format!(
                "({})({})",
                include_str!("../js/media-story-link.js"),
                include_str!("../js/media-profile.js")
            ),
        )
        .await?;
    if let Some(error) = value.get("error").and_then(Value::as_str) {
        return Err(error.to_owned());
    }
    let info: ProfileStory =
        serde_json::from_value(value).map_err(|_| "profile metadata unavailable")?;
    if info.owner.is_empty()
        || info.owner.len() > 32
        || !info.owner.bytes().all(|c| c.is_ascii_digit())
    {
        return Err("invalid profile identity".into());
    }
    Ok(StoryTarget {
        path: info.path.ok_or("no story visible")?,
        owner: Some(info.owner),
    })
}

pub async fn stories(d: &Daemon, args: &[String], cwd: &str, out: &Out) -> Res<()> {
    let (who, dest, limit, _) = arguments(args, 0)?;
    let b = d.browser(out).await?;
    let generation = b.generation.load(std::sync::atomic::Ordering::SeqCst);
    let _account =
        until_cancelled(async { Ok(d.account.read().await) }, || check_client(out)).await?;
    if b.generation.load(std::sync::atomic::Ordering::SeqCst) != generation {
        return Err("account changed; retry".into());
    }
    if out.cancelled() {
        return Err("cancelled".into());
    }
    let (tab, guard) = guarded_tab(&b, false, out).await?;
    let guard = Arc::new(guard);
    let result = until_cancelled(
        async {
            out.err("story privacy is best-effort\n");
            check(&guard, out)?;
            let target = story_path(d, &b, &tab, &who, &guard, out).await?;
            let path = &target.path;
            check(&guard, out)?;
            let parts: Vec<_> = path
                .split(['?', '#'])
                .next()
                .unwrap_or("")
                .split('/')
                .filter(|x| !x.is_empty())
                .collect();
            if parts.len() != 3
                || parts[0] != "stories"
                || parts.iter().any(|p| crate::ops::is_dot_segment(p))
            {
                return Err("need a specific story URL".into());
            }
            let story_id = parts[2];
            b.goto(&tab, &format!("https://www.facebook.com{path}"))
                .await?;
            check(&guard, out)?;
            let value = b
                .eval(
                    &tab,
                    &format!(
                        "({})(decodeURIComponent({}),{},{},{},decodeURIComponent({}))",
                        include_str!("../js/media-story-list.js"),
                        json!(story_id),
                        json!(target.owner),
                        limit,
                        target.owner.is_none(),
                        json!(parts[1])
                    ),
                )
                .await?;
            check(&guard, out)?;
            if value.is_null() {
                return Err("story data not available".into());
            }
            if let Some(error) = value.get("error").and_then(Value::as_str) {
                return Err(error.to_owned());
            }
            let list: StoryItems =
                serde_json::from_value(value).map_err(|_| "invalid story data")?;
            if list.items.is_empty() {
                return Err("no downloadable story media".into());
            }
            let dir = output_dir(cwd, dest.as_deref(), "stories")?;
            let client = client()?;
            out.line(format!("d\t{}", dir.display()));
            let pending = stream::iter(list.items.into_iter().map(|item| {
                let client = client.clone();
                let dir = dir.clone();
                let guard = guard.clone();
                let out = out.clone();
                async move { download(&client, &item, &dir, &guard, &out).await }
            }))
            .buffer_unordered(CONCURRENCY);
            finish_downloads(pending, || check(&guard, out)).await?;
            check(&guard, out)?;
            if !list.missing.is_empty() || list.more {
                return Err("some stories unavailable or not loaded".into());
            }
            Ok(())
        },
        || check(&guard, out),
    )
    .await;
    b.close(tab).await;
    result
}

async fn photo(
    b: &Browser,
    tab: &crate::browser::Tab,
    client: &reqwest::Client,
    dir: &Path,
    item: &PhotoItem,
    guard: &StoryGuard,
    out: &Out,
) -> Res<()> {
    check(guard, out)?;
    b.goto(
        tab,
        &format!("https://www.facebook.com/photo.php?fbid={}", item.id),
    )
    .await?;
    check(guard, out)?;
    let url = b
        .eval(
            tab,
            &format!(
                "({})({})",
                include_str!("../js/media-photo-url.js"),
                json!(item.id)
            ),
        )
        .await?;
    check(guard, out)?;
    let file = Item {
        story: item.index,
        part: 1,
        kind: "Photo".into(),
        url: url.as_str().ok_or("photo not available")?.to_owned(),
    };
    download(client, &file, dir, guard, out).await
}

async fn photo_batch(
    b: &Browser,
    tab: &crate::browser::Tab,
    limit: usize,
    all: bool,
) -> Res<PhotoBatch> {
    let value = b
        .eval(
            tab,
            &format!(
                "({})({}, {}, {})",
                include_str!("../js/media-photo-list.js"),
                include_str!("../js/media-profile.js"),
                limit,
                all
            ),
        )
        .await?;
    if let Some(error) = value.get("error").and_then(Value::as_str) {
        return Err(error.to_owned());
    }
    serde_json::from_value(value).map_err(|_| "photo list not available".into())
}

async fn recovery_urls(
    b: &Browser,
    tab: &crate::browser::Tab,
    profile_url: &str,
    failed: &[PhotoFallback],
    guard: &StoryGuard,
    out: &Out,
) -> Res<Vec<Option<String>>> {
    check(guard, out)?;
    b.goto(tab, profile_url).await?;
    let mut needed: std::collections::HashMap<&str, usize> = failed
        .iter()
        .enumerate()
        .map(|(index, entry)| (entry.item.id.as_str(), index))
        .collect();
    let mut urls = vec![None; failed.len()];
    loop {
        check(guard, out)?;
        let batch = match photo_batch(b, tab, 1000, true).await {
            Ok(batch) => batch,
            Err(_) => {
                check(guard, out)?;
                break;
            }
        };
        for item in batch.items.into_iter().chain(batch.updates) {
            let Some(&index) = needed.get(item.id.as_str()) else {
                continue;
            };
            let Some(url) = item.url else { continue };
            if media_url(&url).is_ok() && !failed[index].attempted.contains(&url) {
                urls[index] = Some(url);
                needed.remove(item.id.as_str());
            }
        }
        if needed.is_empty() || batch.done {
            break;
        }
    }
    Ok(urls)
}

pub async fn photos(d: &Daemon, args: &[String], cwd: &str, out: &Out) -> Res<()> {
    let (who, dest, limit, all) = arguments(args, 10)?;
    let b = d.browser(out).await?;
    let generation = b.generation.load(std::sync::atomic::Ordering::SeqCst);
    let _account =
        until_cancelled(async { Ok(d.account.read().await) }, || check_client(out)).await?;
    if b.generation.load(std::sync::atomic::Ordering::SeqCst) != generation {
        return Err("account changed; retry".into());
    }
    if out.cancelled() {
        return Err("cancelled".into());
    }
    let profile = profile_target(crate::ops::profile_path_explicit(d, &b, &who).await?)?;
    let url = photos_url(&profile)?;
    if out.cancelled() {
        return Err("cancelled".into());
    }
    let (tab, guard) = guarded_tab(&b, true, out).await?;
    let guard = Arc::new(guard);
    let result = until_cancelled(
        async {
            check(&guard, out)?;
            b.goto(&tab, &url).await?;
            check(&guard, out)?;
            let first = photo_batch(&b, &tab, limit, all).await?;
            check(&guard, out)?;
            if first.items.is_empty() && first.done && first.complete {
                return Err("no photos visible".into());
            }
            let dir = output_dir(cwd, dest.as_deref(), "photos")?;
            let client = client()?;
            out.line(format!("d\t{}", dir.display()));
            let (tx, rx) = tokio::sync::mpsc::channel::<PhotoItem>(CONCURRENCY * 2);
            let (fallback_tx, mut fallback_rx) =
                tokio::sync::mpsc::unbounded_channel::<PhotoFallback>();
            let producer_guard = guard.clone();
            let producer_browser = b.clone();
            let producer_out = out.clone();
            let producer_tab = &tab;
            let produce = async move {
                let mut hydrated = std::collections::HashMap::new();
                let result = async {
                    let mut batch = first;
                    let mut count = 0usize;
                    let mut ids = Vec::new();
                    loop {
                        check(&producer_guard, &producer_out)?;
                        if batch.items.len() + batch.updates.len() > 8
                            || (batch.done
                                && (!batch.items.is_empty() || !batch.updates.is_empty()))
                        {
                            return Err("invalid photo list".into());
                        }
                        for item in batch.items {
                            count += 1;
                            if item.index != count
                                || count > limit
                                || item.id.is_empty()
                                || item.id.len() > 32
                                || !item.id.bytes().all(|c| c.is_ascii_digit())
                            {
                                return Err("invalid photo list".into());
                            }
                            ids.push(item.id.clone());
                            tx.send(item).await.map_err(|_| "photo download stopped")?;
                        }
                        for update in batch.updates {
                            let Some(id) = update.index.checked_sub(1).and_then(|i| ids.get(i))
                            else {
                                return Err("invalid photo list".into());
                            };
                            let Some(url) = update.url else {
                                return Err("invalid photo list".into());
                            };
                            if *id != update.id || url.len() > 8192 {
                                return Err("invalid photo list".into());
                            }
                            hydrated.insert(update.index, url);
                        }
                        if batch.done {
                            if batch.missing
                                || (all && !batch.complete)
                                || (count < limit && !batch.complete)
                            {
                                return Err("photo list incomplete".into());
                            }
                            return Ok::<(), String>(());
                        }
                        batch = photo_batch(&producer_browser, producer_tab, limit, all).await?;
                    }
                }
                .await;
                (result, hydrated)
            };
            let consume = async {
                let input = stream::unfold(rx, |mut rx| async {
                    rx.recv().await.map(|item| (item, rx))
                });
                let pending = input
                    .map(|item| {
                        let client = client.clone();
                        let dir = dir.clone();
                        let guard = guard.clone();
                        let out = out.clone();
                        let fallback = fallback_tx.clone();
                        async move {
                            if let PhotoItem {
                                index,
                                id,
                                url: Some(url),
                            } = item
                            {
                                let file = Item {
                                    story: index,
                                    part: 1,
                                    kind: "Photo".into(),
                                    url,
                                };
                                match download(&client, &file, &dir, &guard, &out).await {
                                    Err(error) if recoverable_photo(&error) => {
                                        check(&guard, &out)?;
                                        fallback
                                            .send(PhotoFallback {
                                                item: PhotoItem {
                                                    index,
                                                    id,
                                                    url: None,
                                                },
                                                error: Some(error),
                                                attempted: vec![file.url],
                                            })
                                            .map_err(|_| "photo download stopped".to_string())
                                    }
                                    result => result,
                                }
                            } else {
                                fallback
                                    .send(PhotoFallback {
                                        item,
                                        error: None,
                                        attempted: Vec::new(),
                                    })
                                    .map_err(|_| "photo download stopped".to_string())
                            }
                        }
                    })
                    .buffer_unordered(CONCURRENCY);
                finish_downloads(pending, || check(&guard, out)).await
            };
            tokio::pin!(produce, consume);
            let ((produced, mut hydrated), consumed) = tokio::select! {
                produced = &mut produce => (produced, consume.await),
                consumed = &mut consume => (produce.await, consumed),
            };
            let mut failure = produced.err().or_else(|| consumed.err());
            let mut direct = Vec::new();
            let mut unresolved = Vec::new();
            let mut recover = Vec::new();
            while let Ok(item) = fallback_rx.try_recv() {
                if let Some(url) = hydrated
                    .remove(&item.item.index)
                    .filter(|url| !item.attempted.contains(url))
                {
                    direct.push((item, url))
                } else if item.error.as_deref().is_none_or(retry_photo) {
                    unresolved.push(item)
                } else {
                    recover.push(item)
                }
            }
            let pending = stream::iter(direct.into_iter().map(|(mut item, url)| {
                let client = client.clone();
                let dir = dir.clone();
                let guard = guard.clone();
                let out = out.clone();
                async move {
                    let file = Item {
                        story: item.item.index,
                        part: 1,
                        kind: "Photo".into(),
                        url,
                    };
                    let result = download(&client, &file, &dir, &guard, &out).await;
                    item.attempted.push(file.url);
                    (item, result)
                }
            }))
            .buffer_unordered(CONCURRENCY);
            futures_util::pin_mut!(pending);
            while let Some((mut item, result)) = pending.next().await {
                if let Err(error) = result {
                    check(&guard, out)?;
                    if retry_photo(&error) {
                        item.error = Some(error);
                        unresolved.push(item)
                    } else if recoverable_photo(&error) {
                        item.error = Some(error);
                        recover.push(item)
                    } else {
                        failure.get_or_insert(error);
                    }
                }
            }
            for mut item in unresolved {
                if let Err(error) = photo(&b, &tab, &client, &dir, &item.item, &guard, out).await {
                    check(&guard, out)?;
                    if recoverable_photo(&error) {
                        item.error = Some(error);
                        recover.push(item)
                    } else {
                        failure.get_or_insert(error);
                    }
                }
            }
            while !recover.is_empty() {
                let urls = match recovery_urls(&b, &tab, &url, &recover, &guard, out).await {
                    Ok(urls) => urls,
                    Err(_) => {
                        check(&guard, out)?;
                        vec![None; recover.len()]
                    }
                };
                let pending = stream::iter(recover.into_iter().zip(urls).map(|(mut item, url)| {
                    let client = client.clone();
                    let dir = dir.clone();
                    let guard = guard.clone();
                    let out = out.clone();
                    async move {
                        let attempted = url.is_some();
                        let result = match url {
                            Some(url) => {
                                let file = Item {
                                    story: item.item.index,
                                    part: 1,
                                    kind: "Photo".into(),
                                    url,
                                };
                                let result = download(&client, &file, &dir, &guard, &out).await;
                                item.attempted.push(file.url);
                                result
                            }
                            None => Err(item
                                .error
                                .clone()
                                .unwrap_or_else(|| "photo not available".into())),
                        };
                        (item, attempted, result)
                    }
                }))
                .buffer_unordered(CONCURRENCY);
                futures_util::pin_mut!(pending);
                recover = Vec::new();
                while let Some((mut item, attempted, result)) = pending.next().await {
                    if let Err(error) = result {
                        check(&guard, out)?;
                        if attempted
                            && recoverable_photo(&error)
                            && item.attempted.len() < MAX_RECOVERY_URLS
                        {
                            item.error = Some(error);
                            recover.push(item);
                        } else {
                            failure.get_or_insert(error);
                        }
                    }
                }
            }
            check(&guard, out)?;
            failure.map_or(Ok(()), Err)
        },
        || check(&guard, out),
    )
    .await;
    b.close(tab).await;
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio_rustls::rustls::{
        ServerConfig,
        pki_types::{CertificateDer, PrivatePkcs8KeyDer},
    };

    #[test]
    fn media_hosts_and_types_are_restricted() {
        assert!(media_url("https://scontent.fbcdn.net/file?a=b").is_ok());
        for url in [
            "http://fbcdn.net/file",
            "https://fbcdn.net.evil.example/file",
            "https://fbcdn.net@evil.example/file",
            "https://fbcdn.net:444/file",
            "data:image/png;base64,AAAA",
        ] {
            assert!(media_url(url).is_err(), "{url}");
        }
        assert_eq!(
            extension("image/jpeg; charset=binary", "Photo").unwrap(),
            "jpg"
        );
        assert_eq!(extension("video/mp4", "Video").unwrap(), "mp4");
        assert!(extension("text/html", "Photo").is_err());
        assert!(profile_target("/profile.php?id=123".into()).is_ok());
        assert!(profile_target("/stories/123/456".into()).is_err());
        assert!(profile_target("/alice/posts/123".into()).is_err());
        assert_eq!(
            photos_url("/alice?tracking=x#intro").unwrap(),
            "https://www.facebook.com/alice/photos"
        );
        assert_eq!(
            photos_url("/profile.php?id=123#intro").unwrap(),
            "https://www.facebook.com/profile.php?id=123&sk=photos"
        );
        let cwd = format!("{}\tbad", std::env::temp_dir().display());
        assert!(output_dir(&cwd, Some("photos"), "photos").is_err());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn downloader_saves_verified_bytes_and_preserves_existing_files() {
        // This fixed test-only key and CA are used solely by the loopback server.
        let cert = CertificateDer::from(include_bytes!("../tests/fixture-server.der").to_vec());
        let key = PrivatePkcs8KeyDer::from(include_bytes!("../tests/fixture-key.der").to_vec());
        let config = ServerConfig::builder()
            .with_no_client_auth()
            .with_single_cert(vec![cert], key.into())
            .unwrap();
        let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(config));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let body: Vec<u8> = (0..1_500_000).map(|i| (i % 251) as u8).collect();
        let served = body.clone();
        let server = tokio::spawn(async move {
            for _ in 0..7 {
                let (socket, _) = listener.accept().await.unwrap();
                let mut socket = acceptor.accept(socket).await.unwrap();
                let mut request = [0; 2048];
                let n = socket.read(&mut request).await.unwrap();
                let slow = request[..n].starts_with(b"GET /slow ");
                let stall_headers = request[..n].starts_with(b"GET /stall-headers ");
                let stall_body = request[..n].starts_with(b"GET /stall-body ");
                assert!(
                    slow || stall_headers || stall_body || request[..n].starts_with(b"GET /media ")
                );
                if stall_headers {
                    let _ = tokio::time::timeout(Duration::from_secs(3), socket.read(&mut request))
                        .await;
                    continue;
                }
                socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: image/jpeg\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",served.len()).as_bytes()).await.unwrap();
                if stall_body {
                    socket.write_all(&served[..100]).await.unwrap();
                    let _ = tokio::time::timeout(Duration::from_secs(3), socket.read(&mut request))
                        .await;
                } else if slow {
                    for chunk in served.chunks(200_000) {
                        if socket.write_all(chunk).await.is_err() {
                            break;
                        }
                        tokio::time::sleep(Duration::from_millis(200)).await;
                    }
                } else {
                    let _ = socket.write_all(&served).await;
                }
                let _ = socket.shutdown().await;
            }
        });
        let client = client_builder()
            .no_proxy()
            .read_timeout(Duration::from_millis(800))
            .add_root_certificate(
                reqwest::Certificate::from_der(include_bytes!("../tests/fixture-ca.der")).unwrap(),
            )
            .resolve("fixture.fbcdn.net", address)
            .build()
            .unwrap();
        let dir = std::env::temp_dir().join(format!("fb-media-test-{}", std::process::id()));
        std::fs::create_dir(&dir).unwrap();
        let item = Item {
            story: 1,
            part: 1,
            kind: "Photo".into(),
            url: "https://fixture.fbcdn.net/media".into(),
        };
        assert_eq!(
            download_file(&client, &item, &dir, || Ok(()))
                .await
                .unwrap(),
            "1.jpg"
        );
        assert_eq!(std::fs::read(dir.join("1.jpg")).unwrap(), body);
        assert!(
            download_file(&client, &item, &dir, || Ok(()))
                .await
                .is_err()
        );
        assert_eq!(std::fs::read(dir.join("1.jpg")).unwrap(), body);
        let cancelled = Item { story: 2, ..item };
        let calls = std::sync::atomic::AtomicUsize::new(0);
        assert!(
            download_file(&client, &cancelled, &dir, || {
                if calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
                    Ok(())
                } else {
                    Err("cancelled".into())
                }
            })
            .await
            .is_err()
        );
        assert!(!dir.join("2.jpg").exists());
        let items = vec![
            Item {
                story: 3,
                part: 1,
                kind: "Photo".into(),
                url: "https://invalid.example/media".into(),
            },
            Item {
                story: 4,
                part: 1,
                kind: "Photo".into(),
                url: "https://fixture.fbcdn.net/media".into(),
            },
        ];
        let pending = stream::iter(items.into_iter().map(|item| {
            let client = &client;
            let dir = &dir;
            async move {
                download_file(client, &item, dir, || Ok(()))
                    .await
                    .map(|_| ())
            }
        }))
        .buffer_unordered(1);
        assert_eq!(
            finish_downloads(pending, || Ok(())).await.unwrap_err(),
            "unsupported media host"
        );
        assert_eq!(std::fs::read(dir.join("4.jpg")).unwrap(), body);
        let slow = Item {
            story: 5,
            part: 1,
            kind: "Photo".into(),
            url: "https://fixture.fbcdn.net/slow".into(),
        };
        assert_eq!(
            download_file(&client, &slow, &dir, || Ok(()))
                .await
                .unwrap(),
            "5.jpg"
        );
        assert_eq!(std::fs::read(dir.join("5.jpg")).unwrap(), body);
        for (index, path) in [(6, "stall-headers"), (7, "stall-body")] {
            let flag = Arc::new(std::sync::atomic::AtomicBool::new(false));
            let signal = flag.clone();
            let notifier = tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(250)).await;
                signal.store(true, std::sync::atomic::Ordering::SeqCst);
            });
            let check = || {
                if flag.load(std::sync::atomic::Ordering::SeqCst) {
                    Err("cancelled".into())
                } else {
                    Ok(())
                }
            };
            let stalled = Item {
                story: index,
                part: 1,
                kind: "Photo".into(),
                url: format!("https://fixture.fbcdn.net/{path}"),
            };
            let result = tokio::time::timeout(
                Duration::from_secs(3),
                until_cancelled(download_file(&client, &stalled, &dir, &check), &check),
            )
            .await
            .unwrap();
            assert_eq!(result.unwrap_err(), "cancelled");
            assert!(!dir.join(format!("{index}.jpg")).exists());
            notifier.await.unwrap();
        }
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 3);
        server.await.unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
