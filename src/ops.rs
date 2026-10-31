use crate::browser::Browser;
use crate::cdp::Res;
use crate::daemon::{Daemon, Out};
use serde_json::Value;

pub struct Args {
    pub pos: Vec<String>,
    pub n: Option<usize>,
    pub opts: Vec<(String, String)>,
    pub flags: Vec<String>,
}

/// Minimal arg parser: `-n N`, `--key value` / `--key=value` for `valued` keys, bare `--flag` for
/// `flags`. Anything else starting with `--` is an error (a mistyped `--to` must never be ignored
/// before a post goes out); `--` ends option parsing so text can start with dashes.
pub fn parse(args: &[String], valued: &[&str], flags: &[&str]) -> Res<Args> {
    let mut a = Args {
        pos: vec![],
        n: None,
        opts: vec![],
        flags: vec![],
    };
    let mut i = 0;
    let mut literal = false;
    while i < args.len() {
        let x = args[i].as_str();
        if literal || !x.starts_with('-') || x == "-" {
            a.pos.push(x.to_string());
        } else if x == "--" {
            literal = true;
        } else if x == "-n" {
            a.n = Some(
                args.get(i + 1)
                    .and_then(|v| v.parse().ok())
                    .filter(|n| *n >= 1)
                    .ok_or("bad -n (a positive number)")?,
            );
            i += 1;
        } else if let Some(kv) = x.strip_prefix("--") {
            let (k, inline) = match kv.split_once('=') {
                Some((k, v)) => (k, Some(v.to_string())),
                None => (kv, None),
            };
            if valued.contains(&k) {
                let v = match inline {
                    Some(v) => v,
                    None => {
                        i += 1;
                        let v = args
                            .get(i)
                            .cloned()
                            .ok_or_else(|| format!("--{k} needs a value"))?;
                        // `--match --dry` must not swallow the next option as a value
                        if v.starts_with("--") && v.len() > 2 {
                            return Err(format!(
                                "--{k} needs a value (write --{k}={v} if it really starts with dashes)"
                            ));
                        }
                        v
                    }
                };
                a.opts.push((k.to_string(), v));
            } else if flags.contains(&k) && inline.is_none() {
                a.flags.push(k.to_string());
            } else {
                return Err(format!(
                    "unknown option --{k} (use `--` before text that starts with dashes)"
                ));
            }
        } else {
            return Err(format!(
                "unknown option {x} (use `--` before text that starts with dashes)"
            ));
        }
        i += 1;
    }
    Ok(a)
}

impl Args {
    pub fn opt(&self, k: &str) -> Option<&str> {
        self.opts
            .iter()
            .find(|(x, _)| x == k)
            .map(|(_, v)| v.as_str())
    }
    pub fn opts_all(&self, k: &str) -> Vec<&str> {
        self.opts
            .iter()
            .filter(|(x, _)| x == k)
            .map(|(_, v)| v.as_str())
            .collect()
    }
    pub fn flag(&self, k: &str) -> bool {
        self.flags.iter().any(|f| f == k)
    }
}

/// Appends one TSV cell: text with tabs/newlines flattened, or the short ref of an `{r, v}` object.
fn push_cell(refs: &crate::refs::Refs, c: &Value, line: &mut String) {
    match c {
        Value::String(s) => {
            for (i, part) in s.split(['\t', '\n']).enumerate() {
                if i > 0 {
                    line.push(' ');
                }
                line.push_str(part);
            }
        }
        Value::Object(o) => {
            let kind = o
                .get("r")
                .and_then(Value::as_str)
                .unwrap_or("p")
                .chars()
                .next()
                .unwrap_or('p');
            refs.put_into(kind, o.get("v").and_then(Value::as_str).unwrap_or(""), line);
        }
        other => {
            use std::fmt::Write;
            let _ = write!(line, "{other}");
        }
    }
}

/// Navigate, run `window.__fb.<call>(n)` and print its rows/lines.
pub async fn run_js(
    d: &Daemon,
    b: &std::sync::Arc<Browser>,
    out: &Out,
    url: &str,
    call: &str,
    n: usize,
) -> Res<()> {
    run_expression(
        d,
        b,
        out,
        url,
        &format!("window.__fb.{call}({n}).then(JSON.stringify)"),
    )
    .await
}

async fn run_expression(
    d: &Daemon,
    b: &std::sync::Arc<Browser>,
    out: &Out,
    url: &str,
    expression: &str,
) -> Res<()> {
    let t = b.acquire().await?;
    let r = async {
        b.goto(&t, url).await?;
        let v = b.eval(&t, expression).await?;
        let v: Value =
            serde_json::from_str(v.as_str().unwrap_or("{}")).map_err(|e| e.to_string())?;
        if let Some(e) = v["err"].as_str() {
            return Err(e.to_string());
        }
        print_result(&d.refs, &v, out);
        Ok(())
    }
    .await;
    b.release(t).await;
    r
}

/// A page script's `{rows, lines, note}` as TSV lines (ref cells become short refs) plus the note on stderr.
fn print_result(refs: &crate::refs::Refs, v: &Value, out: &Out) {
    let mut line = String::new();
    for row in v["rows"].as_array().into_iter().flatten() {
        line.clear();
        for (i, c) in row.as_array().into_iter().flatten().enumerate() {
            if i > 0 {
                line.push('\t');
            }
            push_cell(refs, c, &mut line);
        }
        out.line(&line);
    }
    for l in v["lines"].as_array().into_iter().flatten() {
        out.line(l.as_str().unwrap_or(""));
    }
    if let Some(note) = v["note"].as_str() {
        out.err(format!("{note}\n"));
    }
}

/// Facebook path from a url or a `/path`. Rejects every other host, including userinfo tricks
/// such as `https://www.facebook.com@evil.example/`, because the result is navigated to with
/// session cookies and attached files in reach.
pub fn fb_path(spec: &str) -> Option<String> {
    // browsers silently drop tabs/newlines inside URLs (`/me/posts/.<TAB>.` becomes `/me/`)
    if spec.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return None;
    }
    if spec.starts_with('/') {
        return (!spec.starts_with("//") && !spec.contains('\\')).then(|| spec.to_string());
    }
    let rest = spec
        .strip_prefix("https://")
        .or_else(|| spec.strip_prefix("http://"))?;
    let at = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let (host, path) = rest.split_at(at);
    let host = host.to_ascii_lowercase();
    if host.contains(['@', ':', '\\'])
        || !(host == "facebook.com" || host.ends_with(".facebook.com"))
    {
        return None;
    }
    // browsers read `\\` as `/`: `/me/posts/..\\..` would escape every segment check
    if path.contains('\\') {
        return None;
    }
    Some(if path.starts_with('/') {
        path.to_string()
    } else {
        format!("/{path}")
    })
}

fn enc(s: &str) -> String {
    let mut o = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
            o.push(b as char);
        } else {
            o.push_str(&format!("%{b:02X}"));
        }
    }
    o
}

pub async fn uid(d: &Daemon, b: &std::sync::Arc<Browser>) -> Res<String> {
    let c = b
        .cdp
        .call(None, "Storage.getCookies", serde_json::json!({}))
        .await?;
    c["cookies"]
        .as_array()
        // the Facebook cookie only: Messenger may be logged in as someone else
        .and_then(|a| a.iter().find(|c| crate::session::is_login_cookie(c)))
        .and_then(|c| c["value"].as_str())
        .map(String::from)
        .ok_or_else(|| {
            let _ = d;
            "not logged in (run `fb login`)".to_string()
        })
}

/// who → facebook path. Accepts me, url, path, vanity, numeric id, short ref, or a name (searched).
pub async fn profile_path(d: &Daemon, b: &std::sync::Arc<Browser>, who: &str) -> Res<String> {
    if who == "me" {
        return Ok(format!("/profile.php?id={}", uid(d, b).await?));
    }
    if let Some(p) = d.refs.get(who) {
        return Ok(p);
    }
    if who.starts_with('/') || who.starts_with("http") {
        return fb_path(who).ok_or_else(|| format!("not a facebook url: {who}"));
    }
    let who = who.trim_start_matches('@');
    if !who.is_empty() && who.bytes().all(|c| c.is_ascii_digit()) {
        return Ok(format!("/profile.php?id={who}"));
    }
    if !who.is_empty()
        && who
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'.' || c == b'-')
    {
        return Ok(format!("/{who}"));
    }
    person_path(b, who).await
}

pub async fn profile_path_explicit(
    d: &Daemon,
    b: &std::sync::Arc<Browser>,
    who: &str,
) -> Res<String> {
    let name = who.trim_start_matches('@');
    if name.is_empty() {
        return Err("invalid account".into());
    }
    if who.starts_with('@')
        && !name
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'.' || c == b'-')
    {
        return Err("invalid account handle".into());
    }
    if who == "me"
        || who.starts_with('@')
        || d.refs.get(who).is_some()
        || who.bytes().all(|c| c.is_ascii_digit())
        || who.starts_with('/')
        || who.starts_with("http")
    {
        return profile_path(d, b, who).await;
    }
    Err("search for the name and use a profile ref".into())
}

async fn person_path(b: &std::sync::Arc<Browser>, who: &str) -> Res<String> {
    let t = b.acquire().await?;
    let r = async {
        b.goto(
            &t,
            &format!("https://www.facebook.com/search/people/?q={}", enc(who)),
        )
        .await?;
        let v = b
            .eval(&t, "window.__fb.search(1).then(JSON.stringify)")
            .await?;
        let v: Value =
            serde_json::from_str(v.as_str().unwrap_or("{}")).map_err(|e| e.to_string())?;
        v["rows"][0][1]["v"]
            .as_str()
            .map(String::from)
            .ok_or_else(|| format!("no person matches '{who}'"))
    }
    .await;
    b.release(t).await;
    r
}

/// A group spec (ref, url, path, vanity or id) → "/groups/<id>".
/// Rejects the reserved /groups/ sections so "joins" can never become a group.
pub fn group_path(d: &Daemon, spec: &str) -> Res<String> {
    let path = if let Some(p) = d.refs.get(spec) {
        p
    } else if spec.starts_with('/') || spec.starts_with("http") {
        fb_path(spec).ok_or_else(|| format!("not a facebook url: {spec}"))?
    } else {
        format!("/groups/{}", spec.trim_start_matches('@'))
    };
    let seg = path
        .strip_prefix("/groups/")
        .and_then(|rest| rest.split('/').next())
        .filter(|s| {
            !s.is_empty()
                && !matches!(
                    *s,
                    "feed" | "discover" | "joins" | "create" | "search" | "yourgroups"
                )
        })
        .ok_or_else(|| format!("'{spec}' is not a group"))?;
    Ok(format!("/groups/{seg}"))
}

pub async fn search(d: &Daemon, args: &[String], out: &Out) -> Res<()> {
    let a = parse(args, &["type", "match"], &[])?;
    let q = a.pos.join(" ");
    if q.is_empty() {
        return Err(
            "usage: search <query> [--type top|posts|people|friends|photos|videos|pages|places|groups|events|marketplace] [--match text] [-n N]"
                .into(),
        );
    }
    let ty = a.opt("type").unwrap_or("top");
    if ![
        "top", "posts", "people", "friends", "photos", "videos", "pages", "places", "groups",
        "events", "marketplace",
    ]
    .contains(&ty)
    {
        return Err("invalid search type".into());
    }
    let clues = a.opts_all("match");
    if clues.iter().any(|clue| clue.trim().is_empty()) {
        return Err("--match needs text".into());
    }
    let b = d.browser(out).await?;
    let n = a.n.unwrap_or(10);
    match ty {
        // friends is the people tab narrowed by its own Friends chip
        "friends" => {
            let url = format!("https://www.facebook.com/search/people/?q={}", enc(&q));
            let expression = format!(
                "window.__fb.searchFriends({},{}).then(JSON.stringify)",
                n,
                serde_json::json!(clues)
            );
            run_expression(d, &b, out, &url, &expression).await
        }
        // marketplace search lives on its own surface with listing cards
        "marketplace" => {
            let url = format!(
                "https://www.facebook.com/marketplace/search/?query={}",
                enc(&q)
            );
            run_js(d, &b, out, &url, "marketSearch", n).await
        }
        // the All tab and every other vertical share the /search/<type>/ surface
        _ => {
            let url = format!("https://www.facebook.com/search/{ty}/?q={}", enc(&q));
            let expression = format!(
                "window.__fb.search({},{},{}).then(JSON.stringify)",
                n,
                serde_json::json!(clues),
                serde_json::json!(ty)
            );
            run_expression(d, &b, out, &url, &expression).await
        }
    }
}

pub async fn friends(d: &Daemon, args: &[String], out: &Out) -> Res<()> {
    let a = parse(args, &[], &[])?;
    let b = d.browser(out).await?;
    let who = a.pos.first().map(String::as_str).unwrap_or("me");
    let p = profile_path(d, &b, who).await?;
    let url = if p.contains('?') {
        format!("https://www.facebook.com{p}&sk=friends_all")
    } else {
        format!(
            "https://www.facebook.com{}/friends_all",
            p.trim_end_matches('/')
        )
    };
    run_js(d, &b, out, &url, "friends", a.n.unwrap_or(30)).await
}

/// The groups the user has joined, from the joined-groups list page
/// (facebook.com/groups/joins) — not the groups feed, whose links mix in
/// suggestions and only cover groups with recently rendered posts.
/// Rows: name, ref (or the group URL with --urls), privacy/size info.
pub async fn groups(d: &Daemon, args: &[String], out: &Out) -> Res<()> {
    let a = parse(args, &[], &["urls"])?;
    let b = d.browser(out).await?;
    let t = b.acquire().await?;
    let r = async {
        b.goto(&t, "https://www.facebook.com/groups/joins").await?;
        let v = b
            .eval(
                &t,
                &format!(
                    "window.__fb.groups({}).then(JSON.stringify)",
                    a.n.unwrap_or(100)
                ),
            )
            .await?;
        let v: Value =
            serde_json::from_str(v.as_str().unwrap_or("{}")).map_err(|e| e.to_string())?;
        if let Some(e) = v["err"].as_str() {
            return Err(e.to_string());
        }
        for row in v["rows"].as_array().into_iter().flatten() {
            let get = |i: usize| row.get(i).and_then(Value::as_str).unwrap_or("");
            let path = get(1);
            let id = if a.flag("urls") {
                format!("https://www.facebook.com{path}")
            } else {
                d.refs.put('u', path)
            };
            out.line(format!(
                "{}\t{id}\t{}",
                get(0).replace(['\t', '\n'], " "),
                get(2).replace(['\t', '\n'], " ")
            ));
        }
        if let Some(note) = v["note"].as_str() {
            out.err(format!("{note}\n"));
        }
        Ok(())
    }
    .await;
    b.release(t).await;
    r
}

pub async fn profile(d: &Daemon, args: &[String], out: &Out) -> Res<()> {
    let a = parse(args, &[], &[])?;
    let b = d.browser(out).await?;
    let who = a.pos.first().map(String::as_str).unwrap_or("me");
    let p = profile_path(d, &b, who).await?;
    run_js(
        d,
        &b,
        out,
        &format!("https://www.facebook.com{p}"),
        "profile",
        a.n.unwrap_or(0),
    )
    .await
}

pub async fn notifs(d: &Daemon, args: &[String], out: &Out) -> Res<()> {
    let a = parse(args, &[], &[])?;
    let b = d.browser(out).await?;
    run_js(
        d,
        &b,
        out,
        "https://www.facebook.com/notifications/",
        "notifs",
        a.n.unwrap_or(15),
    )
    .await
}

pub async fn resolve_post(d: &Daemon, spec: &str) -> Res<String> {
    if let Some(p) = d.refs.get(spec) {
        return Ok(p);
    }
    if (spec.starts_with('/') || spec.starts_with("http"))
        && let Some(p) = fb_path(spec)
    {
        return Ok(p);
    }
    Err(format!(
        "unknown post '{spec}' (use a ref from `fb feed`, a /path or a url)"
    ))
}

/// `.`, `..` and their percent-encoded forms: browsers collapse them, so they can turn a path that
/// looks like a post into a profile.
pub fn is_dot_segment(s: &str) -> bool {
    let l = s.to_ascii_lowercase().replace("%2e", ".");
    l == "." || l == ".."
}

/// Does this path address one post (not a profile, page or feed)?
pub fn is_post_path(p: &str) -> bool {
    if p.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return false;
    }
    // judged on the path and query only: a fragment or an unrelated parameter proves nothing
    let p = p.split('#').next().unwrap_or("");
    if p.contains('\\') {
        return false;
    }
    let (path, query) = p.split_once('?').unwrap_or((p, ""));
    let has_param = |k: &str| {
        query.split('&').any(|kv| {
            kv.split_once('=')
                .is_some_and(|(n, v)| n == k && !v.is_empty())
        })
    };
    let segs: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    if segs.iter().any(|s| is_dot_segment(s)) {
        return false;
    }
    let after = |name: &str| {
        segs.iter()
            .position(|s| *s == name)
            .is_some_and(|i| i + 1 < segs.len())
    };
    after("posts")
        || after("videos")
        || after("reel")
        || segs.iter().any(|s| s.starts_with("pfbid") && s.len() > 5)
        || (segs.first() == Some(&"permalink.php") && has_param("story_fbid"))
        || (matches!(segs.first(), Some(&"photo") | Some(&"photo.php")) && has_param("fbid"))
        || (segs.first() == Some(&"watch") && has_param("v"))
}

/// For commands that change something (react, comment, delete): the target must be a post, because
/// the page scripts act on the first post they find on whatever page they are given.
pub async fn resolve_post_strict(d: &Daemon, spec: &str) -> Res<String> {
    let p = resolve_post(d, spec).await?;
    if is_post_path(&p) {
        Ok(p)
    } else {
        Err(format!(
            "'{spec}' is not a post (profiles and pages are not valid targets here)"
        ))
    }
}

pub async fn view(d: &Daemon, args: &[String], out: &Out) -> Res<()> {
    let a = parse(args, &[], &[])?;
    let spec = a.pos.first().ok_or("usage: view <post> [-n comments]")?;
    let b = d.browser(out).await?;
    let p = resolve_post(d, spec).await?;
    run_js(
        d,
        &b,
        out,
        &format!("https://www.facebook.com{p}"),
        "postView",
        a.n.unwrap_or(10),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn parse_handles_n_valued_options_and_flags() {
        let a = parse(
            &v(&[
                "hello",
                "world",
                "-n",
                "5",
                "--type",
                "pages",
                "--full",
                "--img=a.png",
                "--img",
                "b.png",
            ]),
            &["type", "img"],
            &["full", "urls"],
        )
        .unwrap();
        assert_eq!(a.pos, ["hello", "world"]);
        assert_eq!(a.n, Some(5));
        assert_eq!(a.opt("type"), Some("pages"));
        assert_eq!(a.opts_all("img"), ["a.png", "b.png"]);
        assert!(a.flag("full") && !a.flag("urls"));
    }

    #[test]
    fn parse_rejects_unknown_options_and_supports_double_dash() {
        assert!(parse(&v(&["-n", "x"]), &[], &[]).is_err());
        assert!(parse(&v(&["-n", "0"]), &[], &[]).is_err());
        assert!(parse(&v(&["--type"]), &["type"], &[]).is_err());
        // a mistyped audience flag must never be silently ignored before a post goes out
        assert!(parse(&v(&["text", "--too", "me"]), &["to"], &[]).is_err());
        assert!(parse(&v(&["--dry=1"]), &[], &["dry"]).is_err());
        // a value-taking option never swallows the next option; --k=value is the escape hatch
        assert!(parse(&v(&["--match", "--dry"]), &["match"], &["dry"]).is_err());
        let a = parse(&v(&["--match=--dry", "--dry"]), &["match"], &["dry"]).unwrap();
        assert_eq!(a.opt("match"), Some("--dry"));
        assert!(a.flag("dry"));
        assert!(parse(&v(&["-x"]), &[], &[]).is_err());
        let a = parse(&v(&["--", "--not-an-option", "-n"]), &["to"], &[]).unwrap();
        assert_eq!(a.pos, ["--not-an-option", "-n"]);
        assert_eq!(parse(&v(&["-"]), &[], &[]).unwrap().pos, ["-"]);
    }

    #[test]
    fn only_post_paths_are_valid_mutation_targets() {
        for ok in [
            "/page/posts/pfbid0X",
            "/groups/1/posts/2",
            "/photo/?fbid=1&set=a.2",
            "/reel/123/",
            "/permalink.php?story_fbid=1&id=2",
            "/watch/videos/1",
        ] {
            assert!(is_post_path(ok), "{ok}");
        }
        for bad in [
            "/me",
            "/profile.php?id=1",
            "/profile.php?id=123#pfbid",
            "/profile.php?id=123&ref=pfbid",
            "/some.page",
            "/groups/1/",
            "/",
            "/posts/",
            "/page/posts",
            "/me/posts/../",
            "/me/posts/%2e%2e/",
            "/me/posts/%2E%2E",
            "/me/posts/./x/../..",
            "/me/posts/..\\..",
            "/me/posts/.\t.",
            "/me/posts/ x",
            "/me/posts/..\\",
        ] {
            assert!(!is_post_path(bad), "{bad}");
        }
    }

    #[test]
    fn fb_path_accepts_only_facebook_hosts() {
        assert_eq!(
            fb_path("https://www.facebook.com/a/posts/1?x=1").as_deref(),
            Some("/a/posts/1?x=1")
        );
        assert_eq!(fb_path("https://m.facebook.com").as_deref(), Some("/"));
        assert_eq!(
            fb_path("http://facebook.com?id=3").as_deref(),
            Some("/?id=3")
        );
        assert_eq!(fb_path("/messages/t/1/").as_deref(), Some("/messages/t/1/"));
        for bad in [
            "https://www.facebook.com@evil.example/messages/t/1/",
            "https://evil.example/www.facebook.com/",
            "https://notfacebook.com/x",
            "https://facebook.com.evil.example/x",
            "https://www.facebook.com:8080@evil.example/",
            "//evil.example/x",
            "ftp://www.facebook.com/",
            "/messages/t/111\\..\\222",
            "/me/posts/.\t.",
            "https://www.facebook.com/me/posts/..\\",
            "https://www.facebook.com/a b",
            "facebook.com/x",
        ] {
            assert_eq!(fb_path(bad), None, "{bad}");
        }
    }

    #[test]
    fn script_results_print_as_tsv_with_short_refs() {
        let f = std::env::temp_dir().join(format!("fb-ops-refs-{}", std::process::id()));
        let _ = std::fs::remove_file(&f);
        let refs = crate::refs::Refs::load(f.clone());
        let (out, mut rx) = Out::channel();
        let v = serde_json::json!({
            "rows": [
                ["a\tb\nc", {"r": "u", "v": "/x"}, 7, null, true, {"v": "/y"}],
                "not a row",
                [],
            ],
            "lines": ["l1", "l2\tkept"],
            "note": "n",
        });
        print_result(&refs, &v, &out);
        drop(out);
        let mut frames = Vec::new();
        while let Ok(f) = rx.try_recv() {
            frames.push((f[0], String::from_utf8(f[5..].to_vec()).unwrap()));
        }
        let (u, p) = (refs.put('u', "/x"), refs.put('p', "/y"));
        let line = |s: &str| (crate::proto::OUT, s.to_string());
        assert_eq!(
            frames,
            [
                line(&format!("a b c\t{u}\t7\tnull\ttrue\t{p}\n")),
                line("\n"),
                line("\n"),
                line("l1\n"),
                line("l2\tkept\n"),
                (crate::proto::ERR, "n\n".to_string()),
            ]
        );
        let _ = std::fs::remove_file(f);
    }

    #[test]
    fn enc_percent_encodes_utf8() {
        assert_eq!(enc("Thanh Tùng"), "Thanh%20T%C3%B9ng");
        assert_eq!(enc("a-b_c.d~e"), "a-b_c.d~e");
    }
}
