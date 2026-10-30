//! Allocation/time benchmarks for the CDP client:
//! `BENCH_CASE=<ax|eval|calls|events> cargo test --release bench_cdp -- --ignored --nocapture`.
//! A fake Chrome runs on its own thread; only the client's threads are counted by the allocator.
use crate::browser::{Browser, Tab};
use crate::cdp::Cdp;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use std::sync::Arc;
use std::sync::atomic::{AtomicIsize, AtomicUsize, Ordering::Relaxed};
use std::time::Instant;
use tokio_tungstenite::tungstenite::Message;

static ALLOCS: AtomicUsize = AtomicUsize::new(0);
static BYTES: AtomicUsize = AtomicUsize::new(0);
static LIVE: AtomicIsize = AtomicIsize::new(0);
static PEAK: AtomicIsize = AtomicIsize::new(0);
thread_local!(static COUNT: Cell<bool> = const { Cell::new(false) });

fn counting() -> bool {
    COUNT.try_with(Cell::get).unwrap_or(false)
}

fn grow(by: isize) {
    let live = LIVE.fetch_add(by, Relaxed) + by;
    PEAK.fetch_max(live, Relaxed);
}

struct Counting;
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        if counting() {
            ALLOCS.fetch_add(1, Relaxed);
            BYTES.fetch_add(l.size(), Relaxed);
            grow(l.size() as isize);
        }
        unsafe { System.alloc(l) }
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        if counting() {
            LIVE.fetch_sub(l.size() as isize, Relaxed);
        }
        unsafe { System.dealloc(p, l) }
    }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, n: usize) -> *mut u8 {
        if counting() {
            ALLOCS.fetch_add(1, Relaxed);
            BYTES.fetch_add(n, Relaxed);
            grow(n as isize - l.size() as isize);
        }
        unsafe { System.realloc(p, l, n) }
    }
}
#[global_allocator]
static A: Counting = Counting;

/// Fake Chrome on its own thread. `reply` maps (id, method) to the frames to send back.
fn fake_chrome(reply: impl Fn(u64, &str) -> Vec<Message> + Send + 'static) -> u16 {
    let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = l.local_addr().unwrap().port();
    std::thread::spawn(move || {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async move {
                l.set_nonblocking(true).unwrap();
                let l = tokio::net::TcpListener::from_std(l).unwrap();
                let (s, _) = l.accept().await.unwrap();
                let ws = tokio_tungstenite::accept_async(s).await.unwrap();
                let (mut tx, mut rx) = ws.split();
                while let Some(Ok(Message::Text(t))) = rx.next().await {
                    let v: Value = serde_json::from_str(t.as_str()).unwrap();
                    for m in reply(v["id"].as_u64().unwrap(), v["method"].as_str().unwrap()) {
                        tx.send(m).await.unwrap();
                    }
                }
            })
    });
    port
}

fn ax_tree(nodes: usize) -> String {
    let nodes: Vec<Value> = (0..nodes)
        .map(|i| {
            json!({"nodeId": i.to_string(), "ignored": false,
                "role": {"type": "role", "value": "link"},
                "name": {"type": "computedString", "value": format!("Friend number {i} of many"),
                    "sources": [{"type": "relatedElement", "attribute": "aria-labelledby"}, {"type": "contents"}]},
                "properties": [{"name": "url", "value": {"type": "string", "value": format!("https://www.facebook.com/profile/{i}")}},
                    {"name": "focusable", "value": {"type": "booleanOrUndefined", "value": true}}],
                "childIds": [(i + 1).to_string()], "backendDOMNodeId": i, "frameId": "F"})
        })
        .collect();
    json!({"nodes": nodes}).to_string()
}

struct Sample {
    ms: f64,
    cpu_ms: f64,
    allocs: usize,
    bytes: usize,
    peak: isize,
}

/// User+system CPU of the whole process (the fake Chrome's thread included; it is the same in every variant).
fn process_cpu_ms() -> f64 {
    let mut u: libc::rusage = unsafe { std::mem::zeroed() };
    unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut u) };
    let tv = |t: libc::timeval| t.tv_sec as f64 * 1e3 + t.tv_usec as f64 / 1e3;
    tv(u.ru_utime) + tv(u.ru_stime)
}

/// Wall time, CPU time, allocation count/bytes and peak live bytes above the start for `f`.
fn measure(f: impl FnOnce()) -> Sample {
    let (a0, b0, l0) = (
        ALLOCS.load(Relaxed),
        BYTES.load(Relaxed),
        LIVE.load(Relaxed),
    );
    PEAK.store(l0, Relaxed);
    // `block_on` polls the caller's future on this thread, so it must be counted too
    COUNT.with(|c| c.set(true));
    let (t, c0) = (Instant::now(), process_cpu_ms());
    f();
    COUNT.with(|c| c.set(false));
    Sample {
        ms: t.elapsed().as_secs_f64() * 1e3,
        cpu_ms: process_cpu_ms() - c0,
        allocs: ALLOCS.load(Relaxed) - a0,
        bytes: BYTES.load(Relaxed) - b0,
        peak: PEAK.load(Relaxed) - l0,
    }
}

fn client_runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .on_thread_start(|| COUNT.with(|c| c.set(true)))
        .build()
        .unwrap()
}

async fn connect(port: u16) -> Arc<Cdp> {
    let tcp = tokio::net::TcpStream::connect(("127.0.0.1", port))
        .await
        .unwrap();
    Cdp::connect(tcp, &format!("ws://127.0.0.1:{port}/"))
        .await
        .unwrap()
}

/// Run `f` (which does `per` units of work) `runs` times and print the median sample.
fn report(case: &str, runs: usize, unit: &str, per: usize, mut f: impl FnMut()) {
    let mut samples: Vec<Sample> = (0..runs).map(|_| measure(&mut f)).collect();
    samples.sort_by(|a, b| a.cpu_ms.partial_cmp(&b.cpu_ms).unwrap());
    let s = &samples[runs / 2];
    println!(
        "BENCH {case}: median_cpu_ms={:.1} wall_ms={:.1} allocs/{unit}={} bytes/{unit}={} peak_live_bytes={}",
        s.cpu_ms,
        s.ms,
        s.allocs / per,
        s.bytes / per,
        s.peak
    );
}

#[test]
#[ignore]
fn bench_cdp() {
    let case = std::env::var("BENCH_CASE").unwrap_or_default();
    let rt = client_runtime();
    match case.as_str() {
        // Accessibility.getFullAXTree-sized reply (~2.5 MB of nested JSON) parsed into a Value
        "ax" => {
            let body = ax_tree(6000);
            let port = fake_chrome(move |id, _| {
                vec![Message::text(format!("{{\"id\":{id},\"result\":{body}}}"))]
            });
            let cdp = rt.block_on(connect(port));
            report("ax", 7, "call", 10, || {
                rt.block_on(async {
                    for _ in 0..10 {
                        let r = cdp
                            .call(Some("S"), "Accessibility.getFullAXTree", json!({}))
                            .await
                            .unwrap();
                        assert_eq!(r["nodes"].as_array().unwrap().len(), 6000);
                    }
                })
            });
        }
        // Runtime.evaluate returnByValue of a 4 MB string, through Browser::eval
        "eval" => {
            let body =
                json!({"result": {"type": "string", "value": "x".repeat(4 << 20)}}).to_string();
            let port = fake_chrome(move |id, _| {
                vec![Message::text(format!("{{\"id\":{id},\"result\":{body}}}"))]
            });
            let b = rt.block_on(async { Browser::new(connect(port).await) });
            let tab = Tab::for_bench("S");
            report("eval", 7, "call", 10, || {
                rt.block_on(async {
                    for _ in 0..10 {
                        let v = b
                            .eval(&tab, "window.__fb.read(50).then(JSON.stringify)")
                            .await
                            .unwrap();
                        assert_eq!(v.as_str().unwrap().len(), 4 << 20);
                    }
                })
            });
        }
        // many concurrent small calls: encode, pending map and reply decode per call
        "calls" => {
            let port = fake_chrome(|id, _| {
                vec![Message::text(format!(
                    "{{\"id\":{id},\"result\":{{\"frameId\":\"F\",\"loaderId\":\"L\"}}}}"
                ))]
            });
            let cdp = rt.block_on(connect(port));
            let (tasks, each) = (32, 500);
            report("calls", 7, "call", tasks * each, || {
                rt.block_on(async {
                    let hs: Vec<_> = (0..tasks)
                        .map(|_| {
                            let c = cdp.clone();
                            tokio::spawn(async move {
                                for _ in 0..each {
                                    let p = json!({"type":"mouseMoved","x":10.5,"y":20.5,"button":"none","buttons":0,"clickCount":0,"pointerType":"mouse"});
                                    c.call(Some("SESSION-0123456789ABCDEF"), "Input.dispatchMouseEvent", p).await.unwrap();
                                }
                            })
                        })
                        .collect();
                    for h in hs {
                        h.await.unwrap();
                    }
                })
            });
        }
        // one event stream fanned out to 8 subscribers (every `goto` and the dialog task listen)
        "events" => {
            let events = 3000;
            let port = fake_chrome(move |id, _| {
                let mut v: Vec<Message> = (0..events)
                    .map(|i| {
                        Message::text(json!({"method":"Page.frameNavigated","sessionId":"SESSION-0123456789ABCDEF","params":{"frame":{"id":"F","loaderId":format!("L{i}"),"url":"https://www.facebook.com/x","mimeType":"text/html"}}}).to_string())
                    })
                    .collect();
                v.push(Message::text(format!("{{\"id\":{id},\"result\":{{}}}}")));
                v
            });
            let cdp = rt.block_on(connect(port));
            report("events", 1, "event", events, || {
                rt.block_on(async {
                    let hs: Vec<_> = (0..8)
                        .map(|_| {
                            let mut rx = cdp.subscribe();
                            tokio::spawn(async move {
                                let mut n = 0;
                                while n < events {
                                    match rx.recv().await {
                                        Ok(e) if e.method == "Page.frameNavigated" => n += 1,
                                        Ok(_) => {}
                                        Err(_) => break,
                                    }
                                }
                                n
                            })
                        })
                        .collect();
                    cdp.call(None, "go", json!({})).await.unwrap();
                    for h in hs {
                        assert_eq!(h.await.unwrap(), events);
                    }
                })
            });
        }
        // daemon -> client reply path of a command that prints many lines (one OUT frame per line):
        // `write_frames` over a unix socket into `pump` writing to a line-buffered stdout
        "ipc" => {
            use crate::proto::{EXIT, OUT, encode};
            let lines = 20_000;
            let mut template: Vec<Vec<u8>> = (0..lines)
                .map(|i| {
                    encode(
                        OUT,
                        format!("c{i:05}\tSome Friend Name\t3h\t0\t0\tlast message preview\n")
                            .as_bytes(),
                    )
                })
                .collect();
            template.push(encode(EXIT, &[0]));
            report("ipc", 7, "frame", lines, || {
                COUNT.with(|c| c.set(false));
                let frames = template.clone();
                // uncounted allocations are freed under counting below: book them as live
                let held = frames.iter().map(|f| f.capacity()).sum::<usize>()
                    + frames.capacity() * std::mem::size_of::<Vec<u8>>();
                LIVE.fetch_add(held as isize, Relaxed);
                COUNT.with(|c| c.set(true));
                let (server, client) = std::os::unix::net::UnixStream::pair().unwrap();
                server.set_nonblocking(true).unwrap();
                let reader = std::thread::spawn(move || {
                    COUNT.with(|c| c.set(true));
                    let mut client = client;
                    let mut stdout =
                        std::io::LineWriter::new(std::fs::File::create("/dev/null").unwrap());
                    crate::client::pump(&mut client, &mut stdout, &mut std::io::sink())
                });
                rt.block_on(async {
                    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
                    for f in frames {
                        tx.send(f).unwrap();
                    }
                    drop(tx);
                    let server = tokio::net::UnixStream::from_std(server).unwrap();
                    crate::daemon::write_frames(rx, server).await;
                });
                assert_eq!(reader.join().unwrap(), 0);
            });
        }
        other => panic!("BENCH_CASE must be ax|eval|calls|events|ipc, got {other:?}"),
    }
    let status = std::fs::read_to_string("/proc/self/status").unwrap();
    println!(
        "BENCH {case}: {}",
        status.lines().find(|l| l.starts_with("VmHWM")).unwrap()
    );
}
