use crate::cdp::Res;
use crate::daemon::{Daemon, Out};

pub async fn run(d: &Daemon, argv: &[String], cwd: &str, out: &Out) -> Res<()> {
    // login waits for a human (Allow click, checkbox, 2FA): it has its own, longer limits
    let limit = if argv.first().map(String::as_str) == Some("login") {
        1200
    } else {
        std::env::var("FB_TIMEOUT")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(150)
    };
    match tokio::time::timeout(
        std::time::Duration::from_secs(limit),
        run_inner(d, argv, cwd, out),
    )
    .await
    {
        Ok(r) => r,
        Err(_) => Err(format!("timed out after {limit}s")),
    }
}

async fn run_inner(d: &Daemon, argv: &[String], _cwd: &str, out: &Out) -> Res<()> {
    let cmd = argv.first().map(String::as_str).unwrap_or("help");
    match cmd {
        "stop" => {
            crate::ipc::remove_endpoint();
            out.line("stopped");
            d.stop_requested
                .store(true, std::sync::atomic::Ordering::SeqCst);
            Ok(())
        }
        "quit" => {
            crate::ipc::remove_endpoint();
            d.quit_browser
                .store(true, std::sync::atomic::Ordering::SeqCst);
            // set first: even if closing the browser hangs, the daemon must still go away
            d.stop_requested
                .store(true, std::sync::atomic::Ordering::SeqCst);
            // also covers a browser this daemon never connected to (e.g. after `fb stop`)
            if crate::connect::managed() {
                let close = async {
                    if let Some(c) = crate::connect::attach().await {
                        let _ = c.call(None, "Browser.close", serde_json::json!({})).await;
                    }
                };
                let _ = tokio::time::timeout(std::time::Duration::from_secs(8), close).await;
            }
            out.line("stopped daemon and browser");
            Ok(())
        }
        "login" => crate::session::login(d, &argv[1..], out).await,
        "help" | "-h" | "--help" => {
            out.line(crate::help::HELP);
            Ok(())
        }
        "status" => crate::dev::status(d, out).await,
        "eval" => crate::dev::eval(d, &argv[1..], out).await,
        "shot" => crate::dev::shot(d, &argv[1..], _cwd, out).await,
        "ax" => crate::dev::ax(d, &argv[1..], out).await,
        "chats" => crate::messenger::chats(d, &argv[1..], out).await,
        "read" => crate::messenger::read(d, &argv[1..], out).await,
        "send" => crate::messenger::send(d, &argv[1..], _cwd, out).await,
        "search" => crate::ops::search(d, &argv[1..], out).await,
        "friends" => crate::ops::friends(d, &argv[1..], out).await,
        "profile" => crate::ops::profile(d, &argv[1..], out).await,
        "notifs" => crate::ops::notifs(d, &argv[1..], out).await,
        "view" => crate::ops::view(d, &argv[1..], out).await,
        "post" => crate::act::post(d, &argv[1..], _cwd, out).await,
        "delete" => crate::act::delete(d, &argv[1..], out).await,
        "comment" => crate::act::comment(d, &argv[1..], out).await,
        "react" => crate::act::react(d, &argv[1..], out).await,
        "unsend" => crate::messenger::unsend(d, &argv[1..], out).await,
        "unlock" => crate::messenger::unlock(d, &argv[1..], out).await,
        "feed" => crate::feed::feed(d, &argv[1..], out).await,
        "posts" => crate::feed::posts(d, &argv[1..], out).await,
        _ => Err(format!("unknown command '{cmd}' (try `fb help`)")),
    }
}
