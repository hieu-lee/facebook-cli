use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::{Mutex, broadcast, mpsc, oneshot};
use tokio_tungstenite::tungstenite::Message;

pub type Res<T> = Result<T, String>;

#[derive(Clone)]
pub struct Event {
    pub method: String,
    pub session: Option<String>,
    pub params: Arc<Value>,
}

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Res<Value>>>>>;

/// Mark the connection dead and fail every in-flight call.
async fn fail_all(pending: &Pending, closed: &std::sync::atomic::AtomicBool) {
    let mut p = pending.lock().await;
    closed.store(true, Ordering::SeqCst);
    for (_, tx) in p.drain() {
        let _ = tx.send(Err("chrome connection closed".into()));
    }
}

pub struct Cdp {
    out: mpsc::UnboundedSender<Message>,
    pending: Pending,
    next: AtomicU64,
    events: broadcast::Sender<Event>,
    pub closed: Arc<std::sync::atomic::AtomicBool>,
    /// reader + writer tasks: aborted on drop so the websocket (and any relay process) really closes
    tasks: Vec<tokio::task::AbortHandle>,
}

impl Drop for Cdp {
    fn drop(&mut self) {
        for t in &self.tasks {
            t.abort();
        }
    }
}

impl Cdp {
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
        let closed = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let (pending2, events2, closed2) = (pending.clone(), events.clone(), closed.clone());
        let (p2, c2) = (pending.clone(), closed.clone());
        let writer = tokio::spawn(async move {
            while let Some(m) = out_rx.recv().await {
                if sink.send(m).await.is_err() {
                    break;
                }
            }
            fail_all(&p2, &c2).await;
        });
        let reader = tokio::spawn(async move {
            while let Some(Ok(msg)) = source.next().await {
                let Message::Text(t) = msg else { continue };
                let Ok(mut v) = serde_json::from_str::<Value>(t.as_str()) else {
                    continue;
                };
                if let Some(id) = v.get("id").and_then(Value::as_u64) {
                    if let Some(tx) = pending.lock().await.remove(&id) {
                        let r = match v.get("error") {
                            Some(e) => Err(e
                                .get("message")
                                .and_then(Value::as_str)
                                .unwrap_or("cdp error")
                                .to_string()),
                            None => Ok(v.get("result").cloned().unwrap_or(Value::Null)),
                        };
                        let _ = tx.send(r);
                    }
                } else if let Some(method) =
                    v.get("method").and_then(Value::as_str).map(String::from)
                {
                    let session = v.get("sessionId").and_then(Value::as_str).map(String::from);
                    let params =
                        Arc::new(v.get_mut("params").map(Value::take).unwrap_or(Value::Null));
                    let _ = events.send(Event {
                        method,
                        session,
                        params,
                    });
                }
            }
            fail_all(&pending, &closed).await;
        });
        Ok(Arc::new(Cdp {
            out,
            pending: pending2,
            next: AtomicU64::new(1),
            events: events2,
            closed: closed2,
            tasks: vec![writer.abort_handle(), reader.abort_handle()],
        }))
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Event> {
        self.events.subscribe()
    }

    pub async fn call(&self, session: Option<&str>, method: &str, params: Value) -> Res<Value> {
        let id = self.next.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        {
            // check + insert under the lock `fail_all` takes, so a call can never be stranded after a disconnect
            let mut p = self.pending.lock().await;
            if self.closed.load(Ordering::SeqCst) {
                return Err("chrome connection closed".into());
            }
            p.insert(id, tx);
        }
        let mut msg = json!({"id": id, "method": method, "params": params});
        if let Some(s) = session {
            msg["sessionId"] = json!(s);
        }
        if self.out.send(Message::text(msg.to_string())).is_err() {
            self.pending.lock().await.remove(&id);
            return Err("chrome connection closed".into());
        }
        rx.await
            .map_err(|_| "chrome connection closed".to_string())?
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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
}
