use crate::cdp::Res;
use crate::daemon::{Daemon, Out};

/// A pending post may be polled for a minute after Post was pressed. Timing out there would
/// report failure for a post Facebook already accepted. The creation answer itself may also
/// take a minute on a slow connection before that polling starts.
const POST_EXTRA_SECS: u64 = 120;

/// groupMembers scrolls 60 ms per member asked, 25 s to 120 s (js/ops.js). The time past the
/// default 25 s comes on top of the limit, or navigation plus a long scroll overruns it and every
/// gathered row is lost.
fn members_extra_secs(argv: &[String]) -> u64 {
    if argv.first().map(String::as_str) != Some("members") {
        return 0;
    }
    let n = argv
        .iter()
        .rposition(|a| a == "-n")
        .and_then(|i| argv.get(i + 1)?.parse::<u64>().ok())
        .unwrap_or(0);
    (n.saturating_mul(60).clamp(25_000, 120_000) - 25_000).div_ceil(1000)
}

/// Over FB_TIMEOUT for `unlock`, so the default limit never cuts a verifying restore short.
const UNLOCK_EXTRA_SECS: u64 = 300;

pub async fn run(d: &Daemon, argv: &[String], cwd: &str, out: &Out) -> Res<()> {
    // login waits for a human (Allow click, checkbox, 2FA): it has its own, longer limits
    let limit = if argv.first().map(String::as_str) == Some("login") {
        1200
    } else {
        let base: u64 = std::env::var("FB_TIMEOUT")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(150);
        // every attachment is uploaded and confirmed on its own (up to 120s each)
        let files = if matches!(argv.first().map(String::as_str), Some("send" | "reply")) {
            argv.iter()
                .filter(|a| matches!(a.split('=').next(), Some("--file" | "--img")))
                .count() as u64
        } else {
            0
        };
        let post = if argv.first().map(String::as_str) == Some("post") {
            POST_EXTRA_SECS
        } else {
            0
        };
        // unlock: two 20s prompt waits and page loads, then up to 240s of PIN verification
        let unlock = if argv.first().map(String::as_str) == Some("unlock") {
            UNLOCK_EXTRA_SECS
        } else {
            0
        };
        base + files * 130 + post + unlock + members_extra_secs(argv)
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
        "resolve" => {
            out.line(d.refs.resolve(&argv[1..])?);
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
        "marketplace" => crate::ops::marketplace(d, &argv[1..], out).await,
        "friends" => crate::ops::friends(d, &argv[1..], out).await,
        "groups" => crate::ops::groups(d, &argv[1..], out).await,
        "events" => crate::ops::events(d, &argv[1..], out).await,
        "pages" => crate::ops::pages(d, &argv[1..], out).await,
        "places" => crate::ops::places(d, &argv[1..], out).await,
        "members" => crate::ops::members(d, &argv[1..], out).await,
        "profile" => crate::ops::profile(d, &argv[1..], out).await,
        "notifs" => crate::ops::notifs(d, &argv[1..], out).await,
        "view" => crate::ops::view(d, &argv[1..], out).await,
        "post" => crate::act::post(d, &argv[1..], _cwd, out).await,
        "delete" => crate::act::delete(d, &argv[1..], out).await,
        "comment" => crate::act::comment(d, &argv[1..], out).await,
        "react" => crate::act::react(d, &argv[1..], out).await,
        "friend-add" => crate::act::friend_add(d, &argv[1..], out).await,
        "group-join" => crate::act::group_join(d, &argv[1..], out).await,
        "group-apply" => crate::act::group_apply(d, &argv[1..], out).await,
        "group-leave" => crate::act::group_leave(d, &argv[1..], out).await,
        "sell" => crate::act::sell(d, &argv[1..], _cwd, out).await,
        "listing-message" => crate::act::listing_message(d, &argv[1..], out).await,
        "follow" => crate::act::follow(d, &argv[1..], out).await,
        "unsend" => crate::messenger::unsend(d, &argv[1..], out).await,
        "msgreact" => crate::messenger::msgreact(d, &argv[1..], out).await,
        "reply" => crate::messenger::send(d, &argv[1..], _cwd, out).await,
        "unlock" => crate::messenger::unlock(d, &argv[1..], out).await,
        "feed" => crate::feed::feed(d, &argv[1..], out).await,
        "posts" => crate::feed::posts(d, &argv[1..], out).await,
        "post-menu" => crate::feed::post_menu(d, &argv[1..], out).await,
        "saved" => crate::feed::saved(d, &argv[1..], out).await,
        _ => Err(format!("unknown command '{cmd}' (try `fb help`)")),
    }
}

#[cfg(test)]
mod tests {
    use super::members_extra_secs;

    fn argv(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn members_allowance_covers_the_longer_scroll() {
        assert_eq!(members_extra_secs(&argv(&["members", "g", "-n", "50"])), 0);
        assert_eq!(members_extra_secs(&argv(&["members", "g"])), 0);
        assert_eq!(
            members_extra_secs(&argv(&["members", "g", "-n", "1000", "--urls"])),
            35
        );
        assert_eq!(
            members_extra_secs(&argv(&["members", "g", "-n", "5000"])),
            95
        );
        assert_eq!(members_extra_secs(&argv(&["posts", "g", "-n", "5000"])), 0);
    }
}
