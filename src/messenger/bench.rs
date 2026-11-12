//! Messenger allocation/time benchmarks (client side only, against an in-process fake Chrome):
//! `cargo test --release bench_ -- --ignored --nocapture --test-threads=1` (`BENCH_MB` sets the file size).
use super::*;
use crate::bench::{Sample, measure};
use serde_json::{Value, json};

// Benchmarks (run: cargo test --release bench_ -- --ignored --nocapture --test-threads=1).
/// Runs `f` (after one warm-up) `n` times and prints the median run by wall time.
fn bench(name: &str, n: usize, mut f: impl FnMut()) {
    f();
    let mut runs: Vec<Sample> = (0..n).map(|_| measure(&mut f)).collect();
    runs.sort_by(|a, b| a.ms.total_cmp(&b.ms));
    let m = &runs[runs.len() / 2];
    println!(
        "BENCH {name}: wall_ms={:.3} cpu_ms={:.3} allocs={} total_MB={:.3} peak_MB={:.3}",
        m.ms,
        m.cpu_ms,
        m.allocs,
        m.bytes as f64 / 1048576.0,
        m.peak as f64 / 1048576.0
    );
}

/// A fake Chrome on its own thread: answers every command without parsing the payload.
fn fake_chrome() -> u16 {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;
    let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = l.local_addr().unwrap().port();
    l.set_nonblocking(true).unwrap();
    std::thread::spawn(move || {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async move {
                let l = tokio::net::TcpListener::from_std(l).unwrap();
                let (s, _) = l.accept().await.unwrap();
                let cfg = tokio_tungstenite::tungstenite::protocol::WebSocketConfig::default()
                    .max_message_size(Some(256 << 20))
                    .max_frame_size(Some(256 << 20));
                let ws = tokio_tungstenite::accept_async_with_config(s, Some(cfg))
                    .await
                    .unwrap();
                let (mut tx, mut rx) = ws.split();
                while let Some(Ok(Message::Text(t))) = rx.next().await {
                    let id: String = t
                        .as_str()
                        .strip_prefix("{\"id\":")
                        .unwrap()
                        .chars()
                        .take_while(char::is_ascii_digit)
                        .collect();
                    let _ = tx
                        .send(Message::text(format!(
                            "{{\"id\":{id},\"result\":{{\"targetId\":\"T\",\"sessionId\":\"S\",\"result\":{{\"type\":\"boolean\",\"value\":true}}}}}}"
                        )))
                        .await;
                }
            });
    });
    port
}

/// send --file of a big file: read it, base64 it, chunk it into CDP Runtime.evaluate calls.
#[test]
#[ignore]
fn bench_attach() {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let mb: usize = std::env::var("BENCH_MB")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(25);
    let dir = std::env::temp_dir().join(format!("fb-bench-att-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("big.pdf").to_string_lossy().into_owned();
    let mut x: u64 = 88172645463325252;
    let data: Vec<u8> = (0..mb << 20)
        .map(|_| {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            x as u8
        })
        .collect();
    std::fs::write(&file, &data).unwrap();
    drop(data);
    let port = fake_chrome();
    let (b, t) = rt.block_on(async {
        let s = tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .unwrap();
        let cdp = crate::cdp::Cdp::connect(s, &format!("ws://127.0.0.1:{port}/"))
            .await
            .unwrap();
        let b = Browser::new(cdp);
        let t = b.acquire().await.unwrap();
        (b, t)
    });
    bench(&format!("attach_{mb}MB"), 7, || {
        rt.block_on(async {
            let bytes = read_attachment(&file).unwrap();
            attach(&b, &t, "big.pdf", &bytes).await.unwrap();
        })
    });
    rt.block_on(async { b.close(t).await });
    std::fs::remove_dir_all(&dir).unwrap();
}

fn synthetic_chats(n: usize) -> Vec<Chat> {
    let names = [
        "Nguyễn Văn",
        "Trần Thị",
        "Lê Hoàng",
        "Alice",
        "Bob Smith",
        "Group: Hikers",
    ];
    (0..n)
        .map(|i| Chat {
            path: if i % 7 == 0 {
                format!("/messages/e2ee/t/{}/", 100000000000 + i)
            } else {
                format!("/messages/t/{}/", 100000000000 + i)
            },
            name: format!("{} {i}", names[i % names.len()]),
            preview: format!("Last message number {i} with some longer preview text in it"),
            time: format!("{}h", i % 24),
            unread: i % 5 == 0,
            group: i % 3 == 0,
        })
        .collect()
}

/// The chat list paths for an account with 5000 chats (the lookup depth): page answer parsing,
/// the on-disk cache, and a by-name lookup against the cached list.
#[test]
#[ignore]
fn bench_chats_5000() {
    let list = synthetic_chats(5000);
    let rows: Vec<Value> = list
        .iter()
        .map(|c| json!({"href": c.path, "name": c.name, "preview": c.preview, "time": c.time, "unread": c.unread, "group": c.group}))
        .collect();
    let page = json!({"chats": rows, "complete": true}).to_string();
    bench("parse_chats_5000", 15, || {
        std::hint::black_box(parse_chats(&page).unwrap());
    });
    let file = std::env::temp_dir().join(format!("fb-bench-chats-{}.tsv", std::process::id()));
    let cache = ChatCache {
        uid: "1".into(),
        at: Instant::now(),
        n: 5000,
        complete: true,
        list: list.into(),
    };
    bench("cache_save_5000", 15, || cache.save(&file));
    bench("cache_load_5000", 15, || {
        std::hint::black_box(ChatCache::load(&file).unwrap());
    });
    bench("lookup_exact_5000", 15, || {
        let l = cache.list.clone();
        let (hits, exact) = find_chats(&l, "alice 4995", true).unwrap();
        assert!(exact && hits.len() == 1);
    });
    bench("lookup_partial_5000", 15, || {
        let l = cache.list.clone();
        assert!(!find_chats(&l, "hikers 4", true).unwrap().0.is_empty());
    });
    std::fs::remove_file(&file).unwrap();
}

/// `read` of a long conversation: formatting the page's messages into output lines.
#[test]
#[ignore]
fn bench_read_lines() {
    let msgs: Vec<Value> = (0..2000)
        .map(|i| {
            if i % 50 == 0 {
                json!({"d": format!("Day {i}")})
            } else {
                json!({"t": "10:00", "from": "me", "text": format!("line one\nline two of message {i} with a bit more text"), "att": if i % 9 == 0 { "img" } else { "" }, "re": if i % 11 == 0 { "👍" } else { "" }})
            }
        })
        .collect();
    let v = json!({ "msgs": msgs });
    bench("read_lines_2000", 15, || {
        let mut n = 0;
        for m in v["msgs"].as_array().into_iter().flatten() {
            n += message_line(m).len();
        }
        std::hint::black_box(n);
    });
}
