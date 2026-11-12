use crate::cdp::Res;
use crate::daemon::{Daemon, Out};

/// Seconds `unlock` may spend beyond the base allowance: two 20s prompt walks
/// plus the 240s PIN verification wait. Cancelling earlier would drop the tab
/// and close the page that is still restoring the chat history.
const UNLOCK_EXTRA_SECS: u64 = 300;

fn command_limit(argv: &[String], base: u64) -> u64 {
    match argv.first().map(String::as_str) {
        // login waits for a human (Allow click, checkbox, 2FA): it has its own, longer limits
        Some("login") => 1200,
        Some("unlock") => base.saturating_add(UNLOCK_EXTRA_SECS),
        Some("send" | "reply") => {
            // every attachment is uploaded and confirmed on its own (up to 120s each)
            let files = argv
                .iter()
                .filter(|a| matches!(a.split('=').next(), Some("--file" | "--img")))
                .count() as u64;
            base.saturating_add(files.saturating_mul(130))
        }
        _ => base,
    }
}

pub async fn run(d: &Daemon, argv: &[String], cwd: &str, out: &Out) -> Res<()> {
    let base: u64 = std::env::var("FB_TIMEOUT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(150);
    let limit = command_limit(argv, base);
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
        "page" => crate::page::run(d, &argv[1..], _cwd, out).await,
        "eval" => crate::dev::eval(d, &argv[1..], out).await,
        "shot" => crate::dev::shot(d, &argv[1..], _cwd, out).await,
        "ax" => crate::dev::ax(d, &argv[1..], out).await,
        "chats" => crate::messenger::chats(d, &argv[1..], out).await,
        "read" => crate::messenger::read(d, &argv[1..], out).await,
        "send" => crate::messenger::send(d, &argv[1..], _cwd, out).await,
        "search" => crate::ops::search(d, &argv[1..], out).await,
        "friends" => crate::ops::friends(d, &argv[1..], out).await,
        "groups" => crate::ops::groups(d, &argv[1..], out).await,
        "members" => crate::ops::members(d, &argv[1..], out).await,
        "profile" => crate::ops::profile(d, &argv[1..], out).await,
        "stories" => crate::media::stories(d, &argv[1..], _cwd, out).await,
        "photos" => crate::media::photos(d, &argv[1..], _cwd, out).await,
        "notifs" => crate::ops::notifs(d, &argv[1..], out).await,
        "view" => crate::ops::view(d, &argv[1..], out).await,
        "post" => crate::act::post(d, &argv[1..], _cwd, out).await,
        "delete" => crate::act::delete(d, &argv[1..], out).await,
        "comment" => crate::act::comment(d, &argv[1..], out).await,
        "react" => crate::act::react(d, &argv[1..], out).await,
        "group-join" => crate::act::group_join(d, &argv[1..], out).await,
        "group-apply" => crate::act::group_apply(d, &argv[1..], out).await,
        "group-leave" => crate::act::group_leave(d, &argv[1..], out).await,
        "friend-add" => crate::act::friend_add(d, &argv[1..], out).await,
        "unsend" => crate::messenger::unsend(d, &argv[1..], out).await,
        "msgreact" => crate::messenger::msgreact(d, &argv[1..], out).await,
        "reply" => crate::messenger::reply(d, &argv[1..], _cwd, out).await,
        "unlock" => crate::messenger::unlock(d, &argv[1..], out).await,
        "feed" => crate::feed::feed(d, &argv[1..], out).await,
        "posts" => crate::feed::posts(d, &argv[1..], out).await,
        _ => Err(format!("unknown command '{cmd}' (try `fb help`)")),
    }
}

#[cfg(test)]
mod tests {
    use super::command_limit;

    fn argv(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn unlock_allowance_covers_the_verification_wait() {
        assert_eq!(command_limit(&argv(&["unlock", "1234"]), 150), 450);
        assert_eq!(command_limit(&argv(&["unlock", "1234"]), 1), 301);
    }

    #[test]
    fn other_commands_keep_their_limits() {
        assert_eq!(command_limit(&argv(&["read", "42"]), 150), 150);
        assert_eq!(command_limit(&argv(&["login"]), 150), 1200);
        assert_eq!(
            command_limit(&argv(&["send", "42", "hi", "--file=a", "--img", "b"]), 150),
            410
        );
    }
}
