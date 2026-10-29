use crate::browser::{Browser, Tab};
use crate::cdp::Res;
use base64::Engine;
use serde_json::{Value, json};
use std::collections::VecDeque;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

// Requests made by workers and sockets do not necessarily pass through the page's Fetch session.
const RESTRICT_CHANNELS: &str = include_str!("../js/story-channels.js");
// https://greasyfork.org/en/scripts/561077-facebook-video-downloader/code
// Unknown or rotated story-query document IDs fail closed.
const QUERY_NAME: &str = "StoriesViewerBucketPrefetcherMultiBucketsQuery";
const QUERY_ID: &str = "9340191609394579";
const QUERY_KEYS: &[&str] = &[
    "av",
    "__aaid",
    "__user",
    "__a",
    "__req",
    "__hs",
    "dpr",
    "__ccg",
    "__rev",
    "__s",
    "__hsi",
    "__dyn",
    "__csr",
    "__comet_req",
    "fb_dtsg",
    "jazoest",
    "lsd",
    "__spin_r",
    "__spin_b",
    "__spin_t",
    "fb_api_caller_class",
    "fb_api_req_friendly_name",
    "variables",
    "server_timestamps",
    "doc_id",
];

pub struct StoryGuard {
    task: tokio::task::JoinHandle<()>,
    failed: Arc<AtomicBool>,
    closed: Arc<AtomicBool>,
    owner_closed: Option<Arc<AtomicBool>>,
    session_watch: crate::cdp::SessionWatch,
}

impl StoryGuard {
    pub fn finished(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
            || self.session_watch.detached()
            || self
                .owner_closed
                .as_ref()
                .is_some_and(|closed| closed.load(Ordering::SeqCst))
            || self.failed.load(Ordering::SeqCst)
            || self.task.is_finished()
    }
}

impl Drop for StoryGuard {
    fn drop(&mut self) {
        self.task.abort();
    }
}

fn read_only_query(body: &str) -> bool {
    let mut name = None;
    let mut id = None;
    for part in body.split('&') {
        let Some((key, value)) = part.split_once('=') else {
            return false;
        };
        if !QUERY_KEYS.contains(&key) {
            return false;
        }
        match key {
            "fb_api_req_friendly_name" if name.replace(value).is_some() => return false,
            "doc_id" if id.replace(value).is_some() => return false,
            _ => {}
        }
    }
    name == Some(QUERY_NAME) && id == Some(QUERY_ID)
}

fn allow_request(event: &Value, root: &str) -> bool {
    if event["resourceType"] == "Document" && event["frameId"].as_str() != Some(root) {
        return false;
    }
    if event["resourceType"] == "Ping" {
        return false;
    }
    let request = &event["request"];
    match request["method"].as_str() {
        Some("GET" | "HEAD") => {
            let Some(url) = request["url"].as_str() else {
                return false;
            };
            if !url.contains("/api/graphql") {
                return true;
            }
            let path = crate::ops::fb_path(url);
            if let Some(("/api/graphql/", body)) = path.as_deref().and_then(|p| p.split_once('?')) {
                read_only_query(body)
            } else {
                !path.as_deref().is_some_and(|p| {
                    matches!(p.split('?').next(), Some("/api/graphql" | "/api/graphql/"))
                })
            }
        }
        Some("POST") => {
            let Some(path) = request["url"].as_str().and_then(crate::ops::fb_path) else {
                return false;
            };
            if path != "/api/graphql/" {
                return false;
            }
            let body = if let Some(body) = request["postData"].as_str() {
                if body.len() > 1024 * 1024 {
                    return false;
                }
                std::borrow::Cow::Borrowed(body)
            } else if let Some(entries) = request["postDataEntries"].as_array() {
                let mut bytes = Vec::new();
                for entry in entries {
                    let Some(encoded) = entry["bytes"].as_str() else {
                        return false;
                    };
                    let remaining = 1024 * 1024 - bytes.len();
                    if encoded.len() > remaining.div_ceil(3) * 4 {
                        return false;
                    }
                    let Ok(data) = base64::engine::general_purpose::STANDARD.decode(encoded) else {
                        return false;
                    };
                    if bytes.len() + data.len() > 1024 * 1024 {
                        return false;
                    }
                    bytes.extend(data);
                }
                let Ok(body) = String::from_utf8(bytes) else {
                    return false;
                };
                std::borrow::Cow::Owned(body)
            } else {
                return false;
            };
            if !request["headers"].as_object().is_some_and(|headers| {
                headers.iter().any(|(key, value)| {
                    key.eq_ignore_ascii_case("content-type")
                        && value.as_str().is_some_and(|v| {
                            v.to_ascii_lowercase()
                                .starts_with("application/x-www-form-urlencoded")
                        })
                })
            }) {
                return false;
            }
            read_only_query(&body)
        }
        _ => false,
    }
}

pub async fn protect(browser: &Arc<Browser>, tab: &Tab) -> Res<StoryGuard> {
    let cdp = browser.cdp.clone();
    let session = tab.session.clone();
    let target = tab.target.clone();
    let context_connection = tab.story_connection();
    let session_watch = cdp.watch_session(&session, context_connection.as_ref());
    let frame = cdp
        .call(Some(&session), "Page.getFrameTree", json!({}))
        .await?;
    let root = frame["frameTree"]["frame"]["id"]
        .as_str()
        .ok_or("story page has no root frame")?
        .to_owned();
    cdp.call(
        Some(&session),
        "Network.setBypassServiceWorker",
        json!({"bypass":true}),
    )
    .await?;
    cdp.call(
        Some(&session),
        "Page.addScriptToEvaluateOnNewDocument",
        json!({"source":format!("({RESTRICT_CHANNELS})({},{},{})", json!(QUERY_NAME), json!(QUERY_ID), json!(QUERY_KEYS))}),
    )
    .await?;
    let mut events = cdp.subscribe();
    let task_cdp = cdp.clone();
    let owner_closed = context_connection
        .as_ref()
        .map(|connection| connection.closed.clone());
    let task_session = session.clone();
    let failed = Arc::new(AtomicBool::new(false));
    let task_failed = failed.clone();
    let task = tokio::spawn(async move {
        let mut requests: tokio::task::JoinSet<Res<Value>> = tokio::task::JoinSet::new();
        let mut waiting = VecDeque::new();
        loop {
            while requests.len() < 64 {
                let Some((method, params)) = waiting.pop_front() else {
                    break;
                };
                let cdp = task_cdp.clone();
                let session = task_session.clone();
                requests.spawn(async move { cdp.call(Some(&session), method, params).await });
            }
            tokio::select! {
                result = requests.join_next(), if !requests.is_empty() => {
                    match result {
                        Some(Ok(Ok(_))) => {}
                        Some(Ok(Err(error))) if error.contains("Invalid InterceptionId") => {}
                        _ => break,
                    }
                }
                event = events.recv() => match event {
                    Ok(event) if event.method == "Cdp.connectionClosed" => break,
                    Ok(event) if event.method == "Target.detachedFromTarget" && event.params["sessionId"].as_str() == Some(&task_session) => break,
                    Ok(event) if event.session.as_deref() == Some(&task_session) && event.method == "Fetch.requestPaused" => {
                        let Some(id) = event.params["requestId"].as_str() else { break };
                        let (method, params) = if allow_request(&event.params, &root) {
                            ("Fetch.continueRequest", json!({"requestId":id}))
                        } else {
                            ("Fetch.failRequest", json!({"requestId":id,"errorReason":"BlockedByClient"}))
                        };
                        if waiting.len() >= 1024 { break; }
                        waiting.push_back((method, params));
                    }
                    Ok(_) => {}
                    Err(_) => break,
                },
            }
        }
        task_failed.store(true, Ordering::SeqCst);
        requests.abort_all();
        if let Some(connection) = context_connection {
            connection.close();
        }
        let _ = tokio::time::timeout(
            std::time::Duration::from_secs(4),
            task_cdp.call(None, "Target.closeTarget", json!({"targetId":target})),
        )
        .await;
    });
    let guard = StoryGuard {
        task,
        failed,
        closed: cdp.closed.clone(),
        owner_closed,
        session_watch,
    };
    cdp.call(
        Some(&session),
        "Fetch.enable",
        json!({"patterns":[{"urlPattern":"*","requestStage":"Request"}]}),
    )
    .await?;
    Ok(guard)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cdp::Cdp;
    use futures_util::{SinkExt, StreamExt};
    use tokio::net::{TcpListener, TcpStream};
    use tokio::sync::mpsc;
    use tokio_tungstenite::tungstenite::Message;

    #[tokio::test]
    async fn protected_page_blocks_seen_and_unknown_writes_but_loads_queries() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (decisions, mut received) = mpsc::unbounded_channel();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let (mut output, mut input) = tokio_tungstenite::accept_async(stream)
                .await
                .unwrap()
                .split();
            let mut held = None;
            let mut released = false;
            while let Some(Ok(Message::Text(text))) = input.next().await {
                let message: Value = serde_json::from_str(&text).unwrap();
                let method = message["method"].as_str().unwrap();
                let result = match method {
                    "Target.createTarget" => json!({"targetId":"T"}),
                    "Target.attachToTarget" => json!({"sessionId":"S"}),
                    "Page.getFrameTree" => json!({"frameTree":{"frame":{"id":"root"}}}),
                    "Fetch.continueRequest" | "Fetch.failRequest" => {
                        decisions
                            .send((
                                message["params"]["requestId"].as_str().unwrap().to_owned(),
                                method.to_owned(),
                            ))
                            .unwrap();
                        json!({})
                    }
                    _ => json!({}),
                };
                if method == "Fetch.continueRequest"
                    && message["params"]["requestId"] == "cancelled"
                {
                    output.send(Message::text(json!({"id":message["id"],"error":{"message":"Invalid InterceptionId."}}).to_string())).await.unwrap();
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                    let event = json!({"method":"Fetch.requestPaused","sessionId":"S","params":{"requestId":"after-cancel","frameId":"root","resourceType":"Image","request":{"method":"GET","url":"https://www.facebook.com/image"}}});
                    output.send(Message::text(event.to_string())).await.unwrap();
                    continue;
                }
                if matches!(method, "Fetch.continueRequest" | "Fetch.failRequest") && !released {
                    if let Some(first) = held.take() {
                        output
                            .send(Message::text(
                                json!({"id":message["id"],"result":result}).to_string(),
                            ))
                            .await
                            .unwrap();
                        output
                            .send(Message::text(json!({"id":first,"result":{}}).to_string()))
                            .await
                            .unwrap();
                        released = true;
                    } else {
                        held = Some(message["id"].clone());
                    }
                    continue;
                }
                output
                    .send(Message::text(
                        json!({"id":message["id"],"result":result}).to_string(),
                    ))
                    .await
                    .unwrap();
                if method == "Fetch.enable" {
                    let requests = [
                        (
                            "document",
                            "GET",
                            "https://www.facebook.com/stories/123",
                            "",
                            "Document",
                            "root",
                        ),
                        (
                            "query",
                            "POST",
                            "https://www.facebook.com/api/graphql/",
                            "fb_api_req_friendly_name=StoriesViewerBucketPrefetcherMultiBucketsQuery&doc_id=9340191609394579&variables=%7B%7D",
                            "Fetch",
                            "root",
                        ),
                        (
                            "seen",
                            "POST",
                            "https://www.facebook.com/api/graphql/",
                            "fb_api_req_friendly_name=storiesUpdateSeenStateMutation",
                            "XHR",
                            "root",
                        ),
                        (
                            "unknown",
                            "POST",
                            "https://www.facebook.com/api/graphql/",
                            "doc_id=42",
                            "Fetch",
                            "root",
                        ),
                        (
                            "duplicate",
                            "POST",
                            "https://www.facebook.com/api/graphql/",
                            "fb_api_req_friendly_name=StoriesViewerBucketPrefetcherMultiBucketsQuery&doc_id=9340191609394579&fb_api_req_friendly_name=storiesUpdateSeenStateMutation",
                            "Fetch",
                            "root",
                        ),
                        (
                            "spoof",
                            "POST",
                            "https://www.facebook.com/api/graphql/",
                            "fb_api_req_friendly_name=StoriesViewerBucketPrefetcherMultiBucketsQuery&doc_id=111",
                            "Fetch",
                            "root",
                        ),
                        (
                            "url-spoof",
                            "POST",
                            "https://www.facebook.com/api/graphql/?doc_id=111",
                            "fb_api_req_friendly_name=StoriesViewerBucketPrefetcherMultiBucketsQuery&doc_id=9340191609394579",
                            "Fetch",
                            "root",
                        ),
                        (
                            "seen-get",
                            "GET",
                            "https://www.facebook.com/api/graphql/?doc_id=111",
                            "",
                            "Fetch",
                            "root",
                        ),
                        (
                            "frame",
                            "GET",
                            "https://example.test/",
                            "",
                            "Document",
                            "child",
                        ),
                        (
                            "cancelled",
                            "GET",
                            "https://www.facebook.com/image",
                            "",
                            "Image",
                            "root",
                        ),
                    ];
                    for (id, verb, url, body, kind, frame) in requests {
                        let event = json!({"method":"Fetch.requestPaused","sessionId":"S","params":{"requestId":id,"frameId":frame,"resourceType":kind,"request":{"method":verb,"url":url,"postData":body,"headers":{"Content-Type":"application/x-www-form-urlencoded"}}}});
                        output.send(Message::text(event.to_string())).await.unwrap();
                    }
                    let body = "fb_api_req_friendly_name=StoriesViewerBucketPrefetcherMultiBucketsQuery&doc_id=9340191609394579";
                    let event = json!({"method":"Fetch.requestPaused","sessionId":"S","params":{"requestId":"entries","frameId":"root","resourceType":"Fetch","request":{"method":"POST","url":"https://www.facebook.com/api/graphql/","postDataEntries":[{"bytes":base64::engine::general_purpose::STANDARD.encode(body)}],"headers":{"Content-Type":"application/x-www-form-urlencoded"}}}});
                    output.send(Message::text(event.to_string())).await.unwrap();
                    let large =
                        base64::engine::general_purpose::STANDARD.encode(vec![0; 2 * 1024 * 1024]);
                    let event = json!({"method":"Fetch.requestPaused","sessionId":"S","params":{"requestId":"oversize","frameId":"root","resourceType":"Fetch","request":{"method":"POST","url":"https://www.facebook.com/api/graphql/","postDataEntries":[{"bytes":large}],"headers":{"Content-Type":"application/x-www-form-urlencoded"}}}});
                    output.send(Message::text(event.to_string())).await.unwrap();
                }
            }
        });
        let stream = TcpStream::connect(address).await.unwrap();
        let cdp = Cdp::connect(stream, &format!("ws://{address}/"))
            .await
            .unwrap();
        let browser = Browser::new(cdp);
        let tab = browser.new_tab(None).await.unwrap();
        let guard = protect(&browser, &tab).await.unwrap();
        let mut results = Vec::new();
        for _ in 0..13 {
            results.push(
                tokio::time::timeout(std::time::Duration::from_secs(2), received.recv())
                    .await
                    .unwrap()
                    .unwrap(),
            );
        }
        results.sort();
        assert_eq!(
            results,
            [
                ("after-cancel".into(), "Fetch.continueRequest".into()),
                ("cancelled".into(), "Fetch.continueRequest".into()),
                ("document".into(), "Fetch.continueRequest".into()),
                ("duplicate".into(), "Fetch.failRequest".into()),
                ("entries".into(), "Fetch.continueRequest".into()),
                ("frame".into(), "Fetch.failRequest".into()),
                ("oversize".into(), "Fetch.failRequest".into()),
                ("query".into(), "Fetch.continueRequest".into()),
                ("seen".into(), "Fetch.failRequest".into()),
                ("seen-get".into(), "Fetch.failRequest".into()),
                ("spoof".into(), "Fetch.failRequest".into()),
                ("unknown".into(), "Fetch.failRequest".into()),
                ("url-spoof".into(), "Fetch.failRequest".into()),
            ]
        );
        assert!(!guard.finished());
        browser.cdp.close();
        assert!(
            guard.finished(),
            "a closed connection must immediately make the guard unhealthy"
        );
        drop(guard);
        browser.close(tab).await;
        server.abort();
    }

    #[tokio::test]
    async fn detaching_a_busy_story_session_closes_the_target() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (closed, mut closed_rx) = mpsc::unbounded_channel();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let (mut output, mut input) = tokio_tungstenite::accept_async(stream)
                .await
                .unwrap()
                .split();
            while let Some(Ok(Message::Text(text))) = input.next().await {
                let message: Value = serde_json::from_str(&text).unwrap();
                let method = message["method"].as_str().unwrap();
                if method == "Fetch.continueRequest" {
                    continue;
                }
                let result = match method {
                    "Target.createTarget" => json!({"targetId":"T"}),
                    "Target.attachToTarget" => json!({"sessionId":"S"}),
                    "Page.getFrameTree" => json!({"frameTree":{"frame":{"id":"root"}}}),
                    "Target.closeTarget" => {
                        let _ = closed.send(());
                        json!({})
                    }
                    _ => json!({}),
                };
                output
                    .send(Message::text(
                        json!({"id":message["id"],"result":result}).to_string(),
                    ))
                    .await
                    .unwrap();
                if method == "Fetch.enable" {
                    for i in 0..65 {
                        let event = json!({"method":"Fetch.requestPaused","sessionId":"S","params":{"requestId":i.to_string(),"frameId":"root","resourceType":"Image","request":{"method":"GET","url":"https://www.facebook.com/image"}}});
                        output.send(Message::text(event.to_string())).await.unwrap();
                    }
                    output.send(Message::text(json!({"method":"Target.detachedFromTarget","params":{"sessionId":"S","targetId":"T"}}).to_string())).await.unwrap();
                }
            }
        });
        let stream = TcpStream::connect(address).await.unwrap();
        let cdp = Cdp::connect(stream, &format!("ws://{address}/"))
            .await
            .unwrap();
        let browser = Browser::new(cdp);
        let tab = browser.new_tab(None).await.unwrap();
        let guard = protect(&browser, &tab).await.unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(2), closed_rx.recv())
            .await
            .expect("detached story target must close")
            .unwrap();
        assert!(guard.finished());
        drop(guard);
        browser.close(tab).await;
        server.abort();
    }

    #[tokio::test]
    async fn detached_session_is_unhealthy_before_guard_task_runs() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (trigger, receive) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let (mut output, mut input) = tokio_tungstenite::accept_async(stream)
                .await
                .unwrap()
                .split();
            let mut receive = Some(receive);
            while let Some(Ok(Message::Text(text))) = input.next().await {
                let message: Value = serde_json::from_str(&text).unwrap();
                let method = message["method"].as_str().unwrap();
                let result = match method {
                    "Target.createTarget" => json!({"targetId":"T"}),
                    "Target.attachToTarget" => json!({"sessionId":"S"}),
                    "Page.getFrameTree" => json!({"frameTree":{"frame":{"id":"root"}}}),
                    _ => json!({}),
                };
                output
                    .send(Message::text(
                        json!({"id":message["id"],"result":result}).to_string(),
                    ))
                    .await
                    .unwrap();
                if method == "Fetch.enable" {
                    receive.take().unwrap().await.unwrap();
                    output.send(Message::text(json!({"method":"Target.detachedFromTarget","params":{"sessionId":"S","targetId":"T"}}).to_string())).await.unwrap();
                }
            }
        });
        let stream = TcpStream::connect(address).await.unwrap();
        let cdp = Cdp::connect(stream, &format!("ws://{address}/"))
            .await
            .unwrap();
        let browser = Browser::new(cdp.clone());
        let tab = browser.new_tab(None).await.unwrap();
        let mut guard = protect(&browser, &tab).await.unwrap();
        guard.task.abort();
        guard.task = tokio::spawn(std::future::pending());
        let mut events = cdp.subscribe();
        trigger.send(()).unwrap();
        loop {
            let event = tokio::time::timeout(std::time::Duration::from_secs(2), events.recv())
                .await
                .unwrap()
                .unwrap();
            if event.method == "Target.detachedFromTarget" {
                break;
            }
        }
        assert!(
            guard.finished(),
            "a detached session must immediately make the guard unhealthy"
        );
        drop(guard);
        browser.close(tab).await;
        server.abort();
    }
}
