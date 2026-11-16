//! Invite friends to a Facebook group from its own Invite dialog. Each name
//! is searched by exact text and selected only when it matches exactly one
//! person; nothing is sent until every requested friend is selected, and
//! `--dry` cancels after selection so nothing reaches Facebook's servers.
use crate::browser::Browser;
use crate::cdp::Res;
use crate::daemon::{Daemon, Out};
use crate::ops::parse;
use serde_json::Value;
use std::sync::Arc;

pub async fn group_invite(d: &Daemon, args: &[String], out: &Out) -> Res<()> {
    let a = parse(args, &[], &["dry"])?;
    let spec = a
        .pos
        .first()
        .ok_or("usage: group-invite <group> <friend>... [--dry]")?;
    let names: Vec<String> = a.pos.iter().skip(1).cloned().collect();
    if names.is_empty() || names.iter().any(|n| n.trim().is_empty()) {
        return Err("usage: group-invite <group> <friend>... [--dry]".into());
    }
    let b: Arc<Browser> = d.browser(out).await?;
    let p = crate::ops::group_path(d, spec)?;
    let gen0 = b.generation.load(std::sync::atomic::Ordering::SeqCst);
    // mutations hold the shared side of the account lock; an account import takes the exclusive side
    let _account = d.account.read().await;
    if b.generation.load(std::sync::atomic::Ordering::SeqCst) != gen0 {
        return Err(
            "the account changed while this command waited; nothing was done, try again".into(),
        );
    }
    let t = b.acquire().await?;
    if crate::act::same_account(&b, gen0).is_err() {
        b.release(t).await;
        return Err("the account changed meanwhile; nothing was done, try again".into());
    }
    let dry = a.flag("dry");
    let run = async {
        b.goto(&t, &format!("https://www.facebook.com{p}")).await?;
        if out.cancelled() {
            return Err("cancelled by client; no invites were sent".into());
        }
        let after = match b
            .eval(
                &t,
                &format!(
                    "window.__fb.groupInvite({}, {})",
                    serde_json::to_string(&names).map_err(|e| e.to_string())?,
                    dry,
                ),
            )
            .await?
        {
            Value::String(v) => v,
            other => return Err(format!("unexpected invite result: {other}")),
        };
        if after == "cancelled" {
            return Err("cancelled by client; no invites were sent".into());
        }
        if let Some(rest) = after.strip_prefix("invited\t") {
            out.line(format!("invited\t{}", rest));
            return Ok(());
        }
        if dry {
            if let Some(rest) = after.strip_prefix("selected\t") {
                out.line(format!(
                    "dry: {}\t{}",
                    "friends selected, not invited", rest
                ));
                return Ok(());
            }
            return Err(format!("dry run failed: {after}"));
        }
        Err(format!("invites not confirmed: {after}"))
    }
    .await;
    b.release(t).await;
    run
}
