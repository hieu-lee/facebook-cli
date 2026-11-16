//! Create a Facebook group from its real creation form. The form needs a name
//! and an explicit Public or Private privacy (Private groups can also be
//! Visible or Hidden); invitations are never sent from here, and success is
//! only reported once Facebook lands on the new group's own page.
use crate::browser::Browser;
use crate::cdp::Res;
use crate::daemon::{Daemon, Out};
use crate::ops::parse;
use serde_json::Value;
use std::sync::Arc;

pub struct Settings {
    pub name: String,
    pub privacy: String,
    pub hidden: bool,
    pub dry: bool,
}

pub fn settings(args: &[String]) -> Res<Settings> {
    let a = parse(args, &["privacy"], &["hidden", "dry"])?;
    let name = a.pos.join(" ");
    if name.trim().is_empty() {
        return Err(
            "usage: group-create <name> --privacy public|private [--hidden] [--dry]".into(),
        );
    }
    if name.chars().any(char::is_control) || name.encode_utf16().count() > 75 {
        return Err("group name must be 1-75 characters with no line breaks".into());
    }
    let privacy = a
        .opt("privacy")
        .ok_or("usage: group-create <name> --privacy public|private [--hidden] [--dry]")?
        .to_string();
    if privacy != "public" && privacy != "private" {
        return Err("--privacy must be public or private".into());
    }
    let hidden = a.flag("hidden");
    if hidden && privacy != "private" {
        return Err("--hidden needs a private group (public groups are always visible)".into());
    }
    Ok(Settings {
        name,
        privacy,
        hidden,
        dry: a.flag("dry"),
    })
}

pub async fn group_create(d: &Daemon, args: &[String], out: &Out) -> Res<()> {
    let s = settings(args)?;
    let b: Arc<Browser> = d.browser(out).await?;
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
    let run = async {
        b.goto(&t, "https://www.facebook.com/groups/create/")
            .await?;
        if out.cancelled() {
            return Err("cancelled by client; no group was created".into());
        }
        let after = match b
            .eval(
                &t,
                &format!(
                    "window.__fb.groupCreate({}, {}, {}, {})",
                    serde_json::to_string(&s.name).map_err(|e| e.to_string())?,
                    serde_json::to_string(&s.privacy).map_err(|e| e.to_string())?,
                    s.hidden,
                    s.dry,
                ),
            )
            .await?
        {
            Value::String(v) => v,
            other => return Err(format!("unexpected creation result: {other}")),
        };
        if s.dry {
            if after == "form-filled" {
                out.line("dry: creation form filled, not created");
                return Ok(());
            }
            return Err(format!("dry run failed: {after}"));
        }
        #[allow(clippy::collapsible_if)]
        if let Some(url) = after.strip_prefix("created\t") {
            if url.starts_with("https://www.facebook.com/groups/")
                && url.trim_end_matches('/').matches('/').count() == 4
            {
                out.line(format!("created\t{}", url.trim_end_matches('/')));
                return Ok(());
            }
        }
        Err("group creation not confirmed; check your groups before trying again".into())
    }
    .await;
    b.release(t).await;
    run
}

#[cfg(test)]
mod tests {
    use super::settings;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn creation_requires_explicit_valid_privacy_and_a_bounded_name() {
        assert!(settings(&args(&["name"])).is_err());
        assert!(settings(&args(&["name", "--privacy", "friends"])).is_err());
        assert!(settings(&args(&["name", "--privacy", "public", "--hidden"])).is_err());
        assert!(settings(&args(&[" ", "--privacy", "private"])).is_err());
        assert!(settings(&args(&["a\nb", "--privacy", "private"])).is_err());
        assert!(settings(&args(&[&"a".repeat(76), "--privacy", "private"])).is_err());
        assert!(settings(&args(&[&"dY~?".repeat(38), "--privacy", "private"])).is_err());
        let s = settings(&args(&[
            "--privacy",
            "private",
            "--hidden",
            "--",
            "--My group",
        ]))
        .unwrap();
        assert_eq!(s.name, "--My group");
        assert_eq!(s.privacy, "private");
        assert!(s.hidden);
        assert!(!s.dry);
        assert!(settings(&args(&["whatever", "--privacy", "bogus"])).is_err());
    }

    #[test]
    fn dry_flag_parses_only_mentioned() {
        let s = settings(&args(&["My group", "--privacy", "public", "--dry"])).unwrap();
        assert!(s.dry);
        assert!(!s.hidden);
    }
}
