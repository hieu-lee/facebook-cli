//! Escape hatches for debugging and one-off page automation.
use crate::cdp::Res;
use crate::daemon::{Daemon, Out};
use base64::Engine;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::time::Duration;

pub async fn eval(d: &Daemon, args: &[String], out: &Out) -> Res<()> {
    let (url, js) = match args.len() {
        1 => (None, &args[0]),
        2 => (Some(&args[0]), &args[1]),
        _ => return Err("usage: eval [url] <js>".into()),
    };
    let b = d.browser(out).await?;
    let t = b.acquire().await?;
    let r = async {
        if let Some(u) = url {
            b.goto(&t, u).await?;
        }
        b.eval(&t, js).await
    }
    .await;
    b.release(t).await;
    let v = r?;
    out.line(
        v.as_str()
            .map(String::from)
            .unwrap_or_else(|| v.to_string()),
    );
    Ok(())
}

pub async fn shot(d: &Daemon, args: &[String], cwd: &str, out: &Out) -> Res<()> {
    let file = args.first().ok_or("usage: shot <file.jpg> [url]")?;
    let file = crate::proto::resolve_path(cwd, file);
    let b = d.browser(out).await?;
    let t = b.acquire().await?;
    let r = async {
        if let Some(u) = args.get(1) {
            b.goto(&t, u).await?;
            tokio::time::sleep(Duration::from_millis(4000)).await;
        }
        b.cdp
            .call(
                Some(&t.session),
                "Page.captureScreenshot",
                json!({"format":"jpeg","quality":60}),
            )
            .await
    }
    .await;
    b.release(t).await;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(r?["data"].as_str().unwrap_or(""))
        .map_err(|e| e.to_string())?;
    std::fs::write(&file, bytes).map_err(|e| e.to_string())?;
    out.line(&file);
    Ok(())
}

type Nodes = HashMap<String, Value>;

fn walk(
    id: &str,
    depth: usize,
    byid: &Nodes,
    kids: &HashMap<String, Vec<String>>,
    out: &mut String,
) {
    let n = &byid[id];
    let role = n["role"]["value"].as_str().unwrap_or("");
    let mut next = depth;
    if !n["ignored"].as_bool().unwrap_or(false)
        && !matches!(role, "none" | "generic" | "InlineTextBox")
    {
        let name = n["name"]["value"].as_str().unwrap_or("");
        let url = n["properties"]
            .as_array()
            .and_then(|a| a.iter().find(|p| p["name"] == "url"))
            .and_then(|p| p["value"]["value"].as_str())
            .unwrap_or("");
        out.push_str(&format!(
            "{}{} {:?} {}\n",
            " ".repeat(depth),
            role,
            name.chars().take(80).collect::<String>(),
            url
        ));
        next += 1;
    }
    for c in kids.get(id).into_iter().flatten() {
        walk(c, next, byid, kids, out);
    }
}

/// Accessibility tree of a page: the fastest way to see what is on screen when writing new selectors.
pub async fn ax(d: &Daemon, args: &[String], out: &Out) -> Res<()> {
    let b = d.browser(out).await?;
    let t = b.acquire().await?;
    let r = async {
        if let Some(u) = args.first() {
            b.goto(&t, u).await?;
            let ms = args.get(1).and_then(|v| v.parse().ok()).unwrap_or(3000);
            tokio::time::sleep(Duration::from_millis(ms)).await;
        }
        b.cdp
            .call(Some(&t.session), "Accessibility.getFullAXTree", json!({}))
            .await
    }
    .await;
    b.release(t).await;
    let nodes = r?["nodes"].as_array().cloned().unwrap_or_default();
    let mut byid: Nodes = HashMap::new();
    let mut kids: HashMap<String, Vec<String>> = HashMap::new();
    for n in &nodes {
        let id = n["nodeId"].as_str().unwrap_or("").to_string();
        if let Some(p) = n["parentId"].as_str() {
            kids.entry(p.to_string()).or_default().push(id.clone());
        }
        byid.insert(id, n.clone());
    }
    let mut text = String::new();
    if let Some(root) = nodes.first() {
        walk(
            root["nodeId"].as_str().unwrap_or(""),
            0,
            &byid,
            &kids,
            &mut text,
        );
    }
    out.out(text);
    Ok(())
}

pub async fn status(d: &Daemon, out: &Out) -> Res<()> {
    let b = d.browser_show(false).await?;
    out.line(format!("browser ok, tabs idle={}", b.idle_count().await));
    if crate::session::logged_in(&b.cdp).await {
        out.line(format!("logged in as {}", crate::ops::uid(d, &b).await?));
    } else {
        out.line(crate::session::NOT_LOGGED_IN);
    }
    Ok(())
}
