use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::{broadcast, mpsc, oneshot};
use tokio_tungstenite::tungstenite::Message;

pub type Res<T> = Result<T, String>;

pub struct EventData {
    pub method: String,
    pub session: Option<String>,
    pub params: Value,
}

/// Shared by every subscriber: cloning it for a broadcast receiver copies no payload.
#[derive(Clone)]
pub struct Event(Arc<EventData>);

impl std::ops::Deref for Event {
    type Target = EventData;
    fn deref(&self) -> &EventData {
        &self.0
    }
}

impl Event {
    fn new(method: String, session: Option<String>, params: Value) -> Event {
        Event(Arc::new(EventData {
            method,
            session,
            params,
        }))
    }
}

#[derive(Serialize)]
struct Request<'a> {
    id: u64,
    method: &'a str,
    params: &'a Value,
    #[serde(rename = "sessionId", skip_serializing_if = "Option::is_none")]
    session: Option<&'a str>,
}

/// One incoming frame: a reply (`id`) or an event (`method`). Fields are parsed straight into
/// their final owners, so a payload is never copied out of a parsed tree.
#[derive(Deserialize)]
struct Incoming {
    id: Option<u64>,
    method: Option<String>,
    #[serde(rename = "sessionId")]
    session: Option<String>,
    params: Option<Value>,
    result: Option<Value>,
    error: Option<Value>,
}

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Res<Value>>>>>;
type DetachWatches = Arc<Mutex<HashMap<String, Weak<DetachSignal>>>>;

struct DetachSignal {
    detached: AtomicBool,
    owner: Option<Weak<Cdp>>,
}

impl DetachSignal {
    fn stop(&self) {
        self.detached.store(true, Ordering::SeqCst);
        if let Some(owner) = self.owner.as_ref().and_then(Weak::upgrade) {
            owner.close();
        }
    }
}

pub struct SessionWatch {
    session: String,
    watches: DetachWatches,
    signal: Arc<DetachSignal>,
}

impl SessionWatch {
    pub fn detached(&self) -> bool {
        self.signal.detached.load(Ordering::SeqCst)
    }
}

impl Drop for SessionWatch {
    fn drop(&mut self) {
        let mut watches = self.watches.lock().unwrap();
        if watches
            .get(&self.session)
            .is_some_and(|watch| Weak::ptr_eq(watch, &Arc::downgrade(&self.signal)))
        {
            watches.remove(&self.session);
        }
    }
}

/// Mark the connection dead and fail every in-flight call.
fn fail_all(
    pending: &Pending,
    closed: &std::sync::atomic::AtomicBool,
    events: &broadcast::Sender<Event>,
    watches: &DetachWatches,
) {
    let mut p = pending.lock().unwrap();
    let first = !closed.swap(true, Ordering::SeqCst);
    for (_, tx) in p.drain() {
        let _ = tx.send(Err("chrome connection closed".into()));
    }
    drop(p);
    if first {
        let watched: Vec<_> = watches
            .lock()
            .unwrap()
            .drain()
            .filter_map(|(_, watch)| watch.upgrade())
            .collect();
        for watch in watched {
            watch.stop();
        }
        let _ = events.send(Event::new("Cdp.connectionClosed".into(), None, Value::Null));
    }
}

struct PendingCall {
    pending: Pending,
    id: u64,
}

impl Drop for PendingCall {
    fn drop(&mut self) {
        self.pending.lock().unwrap().remove(&self.id);
    }
}

pub struct Cdp {
    out: mpsc::UnboundedSender<Message>,
    pending: Pending,
    next: AtomicU64,
    events: broadcast::Sender<Event>,
    detach_watches: DetachWatches,
    pub closed: Arc<std::sync::atomic::AtomicBool>,
    /// reader + writer tasks: aborted on drop so the websocket (and any relay process) really closes
    tasks: Vec<tokio::task::AbortHandle>,
}

impl Drop for Cdp {
    fn drop(&mut self) {
        self.close();
    }
}

impl Cdp {
    pub fn close(&self) {
        fail_all(
            &self.pending,
            &self.closed,
            &self.events,
            &self.detach_watches,
        );
        for task in &self.tasks {
            task.abort();
        }
    }

    pub async fn connect<S>(stream: S, url: &str) -> Res<Arc<Cdp>>
    where
        S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    {
        let config = tokio_tungstenite::tungstenite::protocol::WebSocketConfig::default()
            .max_message_size(Some(256 << 20))
            .max_frame_size(Some(256 << 20));
        let (ws, _) = tokio_tungstenite::client_async_with_config(url, stream, Some(config))
            .await
            .map_err(|e| format!("ws handshake: {e}"))?;
        let (mut sink, mut source) = ws.split();
        let (out, mut out_rx) = mpsc::unbounded_channel::<Message>();
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let (events, _) = broadcast::channel(4096);
        let detach_watches: DetachWatches = Arc::new(Mutex::new(HashMap::new()));
        let reader_watches = detach_watches.clone();
        let writer_watches = detach_watches.clone();
        let closed = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let (pending2, events2, closed2) = (pending.clone(), events.clone(), closed.clone());
        let (p2, c2) = (pending.clone(), closed.clone());
        let writer_events = events.clone();
        let writer = tokio::spawn(async move {
            while let Some(m) = out_rx.recv().await {
                if sink.send(m).await.is_err() {
                    break;
                }
            }
            fail_all(&p2, &c2, &writer_events, &writer_watches);
        });
        let reader = tokio::spawn(async move {
            while let Some(Ok(msg)) = source.next().await {
                let Message::Text(t) = msg else { continue };
                let Ok(frame) = serde_json::from_str::<Incoming>(t.as_str()) else {
                    continue;
                };
                if let Some(id) = frame.id {
                    if let Some(tx) = pending.lock().unwrap().remove(&id) {
                        let r = match frame.error {
                            Some(e) => Err(e
                                .get("message")
                                .and_then(Value::as_str)
                                .unwrap_or("cdp error")
                                .to_string()),
                            None => Ok(frame.result.unwrap_or(Value::Null)),
                        };
                        let _ = tx.send(r);
                    }
                } else if let Some(method) = frame.method {
                    let params = frame.params.unwrap_or(Value::Null);
                    if method == "Target.detachedFromTarget"
                        && let Some(session) = params["sessionId"].as_str()
                    {
                        let watch = reader_watches
                            .lock()
                            .unwrap()
                            .remove(session)
                            .and_then(|watch| watch.upgrade());
                        if let Some(watch) = watch {
                            watch.stop();
                        }
                    }
                    let _ = events.send(Event::new(method, frame.session, params));
                }
            }
            fail_all(&pending, &closed, &events, &reader_watches);
        });
        Ok(Arc::new(Cdp {
            out,
            pending: pending2,
            next: AtomicU64::new(1),
            events: events2,
            detach_watches,
            closed: closed2,
            tasks: vec![writer.abort_handle(), reader.abort_handle()],
        }))
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Event> {
        self.events.subscribe()
    }

    pub fn watch_session(&self, session: &str, owner: Option<&Arc<Cdp>>) -> SessionWatch {
        let signal = Arc::new(DetachSignal {
            detached: AtomicBool::new(false),
            owner: owner.map(Arc::downgrade),
        });
        let mut watches = self.detach_watches.lock().unwrap();
        if self.closed.load(Ordering::SeqCst) {
            drop(watches);
            signal.stop();
        } else {
            watches.insert(session.to_owned(), Arc::downgrade(&signal));
        }
        SessionWatch {
            session: session.to_owned(),
            watches: self.detach_watches.clone(),
            signal,
        }
    }

    pub async fn call(&self, session: Option<&str>, method: &str, params: Value) -> Res<Value> {
        self.send_frame(|id| {
            serde_json::to_string(&Request {
                id,
                method,
                params: &params,
                session,
            })
            .map_err(|e| e.to_string())
        })
        .await
    }

    /// Like `call`, with `params` given as pieces of already-valid JSON whose concatenation is the
    /// params object. For one huge string the caller has proven needs no escaping (base64): the
    /// frame is assembled in a single allocation, without copying it into a `Value` or rescanning it.
    pub async fn call_json(
        &self,
        session: Option<&str>,
        method: &str,
        params: &[&str],
    ) -> Res<Value> {
        let size = params.iter().map(|p| p.len()).sum::<usize>();
        self.send_frame(|id| {
            let mut frame = String::with_capacity(size + 256);
            frame.push_str(&format!(
                "{{\"id\":{id},\"method\":{},\"params\":",
                serde_json::Value::from(method)
            ));
            params.iter().for_each(|p| frame.push_str(p));
            if let Some(s) = session {
                frame.push_str(&format!(",\"sessionId\":{}", serde_json::Value::from(s)));
            }
            frame.push('}');
            Ok(frame)
        })
        .await
    }

    async fn send_frame(&self, frame: impl FnOnce(u64) -> Res<String>) -> Res<Value> {
        let id = self.next.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        {
            // check + insert under the lock `fail_all` takes, so a call can never be stranded after a disconnect
            let mut p = self.pending.lock().unwrap();
            if self.closed.load(Ordering::SeqCst) {
                return Err("chrome connection closed".into());
            }
            p.insert(id, tx);
        }
        let _pending = PendingCall {
            pending: self.pending.clone(),
            id,
        };
        if self.out.send(Message::text(frame(id)?)).is_err() {
            return Err("chrome connection closed".into());
        }
        rx.await
            .map_err(|_| "chrome connection closed".to_string())?
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tokio::net::TcpListener;

    /// Fake Chrome: answers every command with {echo: method}, and emits one event after `ping`.
    async fn fake_chrome() -> u16 {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (s, _) = l.accept().await.unwrap();
            let ws = tokio_tungstenite::accept_async(s).await.unwrap();
            let (mut tx, mut rx) = ws.split();
            while let Some(Ok(Message::Text(t))) = rx.next().await {
                let v: Value = serde_json::from_str(t.as_str()).unwrap();
                let m = v["method"].as_str().unwrap().to_string();
                if m == "boom" {
                    let _ = tx
                        .send(Message::text(
                            json!({"id": v["id"], "error": {"message": "nope"}}).to_string(),
                        ))
                        .await;
                    continue;
                }
                if m == "ping" {
                    let _ = tx.send(Message::text(json!({"method": "Page.loadEventFired", "params": {}, "sessionId": "S1"}).to_string())).await;
                }
                let _ = tx
                    .send(Message::text(
                        json!({"id": v["id"], "result": {"echo": m}}).to_string(),
                    ))
                    .await;
            }
        });
        port
    }

    #[tokio::test]
    async fn cancelling_an_unanswered_call_removes_its_pending_entry() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (started, ready) = oneshot::channel();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
            let _ = ws.next().await;
            let _ = started.send(());
            while ws.next().await.is_some() {}
        });
        let stream = tokio::net::TcpStream::connect(address).await.unwrap();
        let cdp = Cdp::connect(stream, &format!("ws://{address}/"))
            .await
            .unwrap();
        let client = cdp.clone();
        let request = tokio::spawn(async move {
            client
                .call(Some("S"), "Fetch.continueRequest", json!({}))
                .await
        });
        ready.await.unwrap();
        assert_eq!(cdp.pending.lock().unwrap().len(), 1);
        request.abort();
        let _ = request.await;
        assert_eq!(cdp.pending.lock().unwrap().len(), 0);
        drop(cdp);
        server.abort();
    }

    #[tokio::test]
    async fn calls_are_multiplexed_and_errors_surface() {
        let port = fake_chrome().await;
        let tcp = tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .unwrap();
        let cdp = Cdp::connect(tcp, &format!("ws://127.0.0.1:{port}/"))
            .await
            .unwrap();
        let mut ev = cdp.subscribe();
        let (a, b, c) = tokio::join!(
            cdp.call(None, "one", json!({})),
            cdp.call(Some("S"), "ping", json!({})),
            cdp.call(None, "boom", json!({}))
        );
        assert_eq!(a.unwrap()["echo"], "one");
        assert_eq!(b.unwrap()["echo"], "ping");
        assert_eq!(c.unwrap_err(), "nope");
        let e = ev.recv().await.unwrap();
        assert_eq!(
            (e.method.as_str(), e.session.as_deref()),
            ("Page.loadEventFired", Some("S1"))
        );
    }

    #[tokio::test]
    async fn call_json_assembles_the_same_frame_as_call() {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (s, _) = l.accept().await.unwrap();
            let ws = tokio_tungstenite::accept_async(s).await.unwrap();
            let (mut tx, mut rx) = ws.split();
            while let Some(Ok(Message::Text(t))) = rx.next().await {
                let v: Value = serde_json::from_str(t.as_str()).unwrap();
                let reply = json!({"id": v["id"], "result": {"frame": v}});
                let _ = tx.send(Message::text(reply.to_string())).await;
            }
        });
        let tcp = tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .unwrap();
        let cdp = Cdp::connect(tcp, &format!("ws://127.0.0.1:{port}/"))
            .await
            .unwrap();
        let parts = [
            "{\"expression\":\"f('",
            "QUJD",
            "')\",\"awaitPromise\":true}",
        ];
        let raw = cdp
            .call_json(Some("S"), "Runtime.evaluate", &parts)
            .await
            .unwrap();
        let params = json!({"expression": "f('QUJD')", "awaitPromise": true});
        let typed = cdp
            .call(Some("S"), "Runtime.evaluate", params)
            .await
            .unwrap();
        let (raw, typed) = (&raw["frame"], &typed["frame"]);
        assert_eq!(raw["params"], typed["params"]);
        assert_eq!(raw["method"], typed["method"]);
        assert_eq!(raw["sessionId"], "S");
        assert_ne!(raw["id"], typed["id"]);
        let bare = cdp.call_json(None, "Page.enable", &["{}"]).await.unwrap();
        assert_eq!(bare["frame"]["params"], json!({}));
        assert!(bare["frame"].get("sessionId").is_none());
    }

    #[tokio::test]
    async fn calls_after_disconnect_fail_fast_instead_of_hanging() {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (s, _) = l.accept().await.unwrap();
            let ws = tokio_tungstenite::accept_async(s).await.unwrap();
            drop(ws);
        });
        let tcp = tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .unwrap();
        let cdp = Cdp::connect(tcp, &format!("ws://127.0.0.1:{port}/"))
            .await
            .unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        for _ in 0..3 {
            let r = tokio::time::timeout(
                std::time::Duration::from_secs(3),
                cdp.call(None, "x", json!({})),
            )
            .await;
            assert_eq!(
                r.expect("call must not hang").unwrap_err(),
                "chrome connection closed"
            );
        }
    }

    #[tokio::test]
    async fn dropping_the_handle_closes_the_websocket() {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        let (done_tx, done_rx) = oneshot::channel();
        tokio::spawn(async move {
            let (s, _) = l.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(s).await.unwrap();
            while ws.next().await.is_some() {}
            let _ = done_tx.send(());
        });
        let tcp = tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .unwrap();
        let cdp = Cdp::connect(tcp, &format!("ws://127.0.0.1:{port}/"))
            .await
            .unwrap();
        drop(cdp);
        tokio::time::timeout(std::time::Duration::from_secs(3), done_rx)
            .await
            .expect("server must see the connection close")
            .unwrap();
    }

    #[tokio::test]
    async fn closing_a_shared_handle_closes_the_websocket() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (done, closed) = oneshot::channel();
        tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
            while ws.next().await.is_some() {}
            let _ = done.send(());
        });
        let stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .unwrap();
        let cdp = Cdp::connect(stream, &format!("ws://127.0.0.1:{port}/"))
            .await
            .unwrap();
        let retained = cdp.clone();
        let request_cdp = cdp.clone();
        let request =
            tokio::spawn(async move { request_cdp.call(None, "stalled", json!({})).await });
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        cdp.close();
        tokio::time::timeout(std::time::Duration::from_secs(3), closed)
            .await
            .expect("server must see the connection close")
            .unwrap();
        drop(retained);
        assert!(request.await.unwrap().is_err());
    }

    #[tokio::test]
    async fn detached_session_closes_its_owner_without_an_event_consumer() {
        let owner_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let owner_address = owner_listener.local_addr().unwrap();
        let (owner_closed, closed_rx) = oneshot::channel();
        let owner_server = tokio::spawn(async move {
            let (stream, _) = owner_listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
            while ws.next().await.is_some() {}
            let _ = owner_closed.send(());
        });
        let stream = tokio::net::TcpStream::connect(owner_address).await.unwrap();
        let owner = Cdp::connect(stream, &format!("ws://{owner_address}/"))
            .await
            .unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (trigger, receive) = oneshot::channel();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
            receive.await.unwrap();
            ws.send(Message::text(
                json!({"method":"Target.detachedFromTarget","params":{"sessionId":"S"}})
                    .to_string(),
            ))
            .await
            .unwrap();
            while ws.next().await.is_some() {}
        });
        let stream = tokio::net::TcpStream::connect(address).await.unwrap();
        let cdp = Cdp::connect(stream, &format!("ws://{address}/"))
            .await
            .unwrap();
        let watch = cdp.watch_session("S", Some(&owner));
        let mut events = cdp.subscribe();
        trigger.send(()).unwrap();
        let event = tokio::time::timeout(std::time::Duration::from_secs(2), events.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(event.method, "Target.detachedFromTarget");
        assert!(watch.detached());
        tokio::time::timeout(std::time::Duration::from_secs(2), closed_rx)
            .await
            .expect("owner must close without waiting for the guard task")
            .unwrap();
        server.abort();
        owner_server.abort();
    }

    #[tokio::test]
    async fn lost_connection_closes_watched_owner_without_an_event_consumer() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (closed, closed_rx) = oneshot::channel();
        let owner_server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
            while ws.next().await.is_some() {}
            let _ = closed.send(());
        });
        let stream = tokio::net::TcpStream::connect(address).await.unwrap();
        let owner = Cdp::connect(stream, &format!("ws://{address}/"))
            .await
            .unwrap();
        let port = fake_chrome().await;
        let stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .unwrap();
        let cdp = Cdp::connect(stream, &format!("ws://127.0.0.1:{port}/"))
            .await
            .unwrap();
        let _watch = cdp.watch_session("S", Some(&owner));
        cdp.close();
        tokio::time::timeout(std::time::Duration::from_secs(2), closed_rx)
            .await
            .expect("owner must close without waiting for the guard task")
            .unwrap();
        owner_server.abort();
    }
}
