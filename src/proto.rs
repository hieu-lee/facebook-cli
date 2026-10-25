use std::io::Read;

pub const OUT: u8 = b'o';
pub const ERR: u8 = b'e';
pub const EXIT: u8 = b'x';

/// Per-user state directory (private). Holds the socket fallback, refs, caches and logs.
pub fn state_dir() -> std::path::PathBuf {
    if let Ok(d) = std::env::var("FB_STATE") {
        return d.into();
    }
    #[cfg(windows)]
    {
        let base = std::env::var("LOCALAPPDATA")
            .or_else(|_| std::env::var("USERPROFILE"))
            .unwrap_or_else(|_| ".".into());
        std::path::PathBuf::from(base).join("fb")
    }
    #[cfg(not(windows))]
    {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
        std::path::PathBuf::from(home).join(".cache/fb")
    }
}

/// Create `p` readable by the current user only (mode 0700; on Windows the profile dir ACL already is).
pub fn private_dir(p: &std::path::Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
        let _ = std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(p);
        let _ = std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o700));
    }
    #[cfg(not(unix))]
    {
        let _ = std::fs::create_dir_all(p);
    }
}

/// A path given on the client's command line, resolved against the client's working directory.
pub fn resolve_path(cwd: &str, p: &str) -> String {
    let p = std::path::Path::new(p);
    if p.is_absolute() {
        p.to_string_lossy().into_owned()
    } else {
        std::path::Path::new(cwd)
            .join(p)
            .to_string_lossy()
            .into_owned()
    }
}

pub fn encode(tag: u8, data: &[u8]) -> Vec<u8> {
    let mut v = Vec::with_capacity(5 + data.len());
    v.push(tag);
    v.extend_from_slice(&(data.len() as u32).to_be_bytes());
    v.extend_from_slice(data);
    v
}

pub fn read_frame<R: Read>(r: &mut R) -> std::io::Result<(u8, Vec<u8>)> {
    let mut h = [0u8; 5];
    r.read_exact(&mut h)?;
    let n = u32::from_be_bytes([h[1], h[2], h[3], h[4]]) as usize;
    let mut d = vec![0u8; n];
    r.read_exact(&mut d)?;
    Ok((h[0], d))
}

/// Split a command line into words, honouring single/double quotes and backslashes.
/// `None` for malformed input (unterminated quote, dangling backslash).
pub fn shlex(s: &str) -> Option<Vec<String>> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut has = false;
    let mut q: Option<char> = None;
    let mut it = s.chars().peekable();
    while let Some(c) = it.next() {
        match (q, c) {
            (Some(qc), c) if c == qc => q = None,
            // POSIX: inside double quotes a backslash escapes only these; elsewhere it stays literal
            // (`"\d+"`, `"C:\pics\a.png"`)
            (Some('"'), '\\') => match it.peek() {
                Some(&n) if matches!(n, '"' | '\\' | '$' | '`') => {
                    cur.push(n);
                    it.next();
                }
                _ => cur.push('\\'),
            },
            (Some(_), c) => cur.push(c),
            (None, '\'' | '"') => {
                q = Some(c);
                has = true;
            }
            (None, '\\') => {
                // a trailing backslash escapes nothing: malformed
                cur.push(it.next()?);
                has = true;
            }
            (None, c) if c.is_whitespace() => {
                if has || !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                    has = false;
                }
            }
            (None, c) => cur.push(c),
        }
    }
    if q.is_some() {
        return None; // unterminated quote: refusing beats running a truncated command
    }
    if has || !cur.is_empty() {
        out.push(cur);
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shlex_splits_quotes_and_escapes() {
        assert_eq!(
            shlex(r#"send ny "hello world" --img 'a b.png'"#).unwrap(),
            ["send", "ny", "hello world", "--img", "a b.png"]
        );
        assert_eq!(
            shlex(r#"say "he said \"hi\"""#).unwrap(),
            ["say", r#"he said "hi""#]
        );
        assert_eq!(shlex("a\\ b c").unwrap(), ["a b", "c"]);
        assert_eq!(
            shlex(r#"send 1 "Use \d+ in C:\pics\a.png and \\ too""#).unwrap(),
            ["send", "1", r"Use \d+ in C:\pics\a.png and \ too"]
        );
        assert_eq!(shlex(r#"empty "" x"#).unwrap(), ["empty", "", "x"]);
        assert!(shlex("   ").unwrap().is_empty());
        // truncated commands must never run (a lost `--to me` would change who sees a post)
        assert_eq!(shlex(r#"post "private text --to me"#), None);
        assert_eq!(shlex("post it\\"), None);
    }

    #[test]
    fn relative_paths_resolve_against_the_client_cwd() {
        let cwd = std::env::temp_dir();
        let cwd = cwd.to_string_lossy();
        let abs = std::env::temp_dir().join("a.png");
        assert_eq!(
            resolve_path(&cwd, &abs.to_string_lossy()),
            abs.to_string_lossy()
        );
        assert_eq!(
            resolve_path(&cwd, "b.png"),
            std::path::Path::new(&*cwd).join("b.png").to_string_lossy()
        );
    }

    #[test]
    fn frames_roundtrip() {
        let f = encode(OUT, "héllo".as_bytes());
        let (tag, body) = read_frame(&mut &f[..]).unwrap();
        assert_eq!((tag, body), (OUT, "héllo".as_bytes().to_vec()));
        let f = encode(EXIT, &[3]);
        assert_eq!(read_frame(&mut &f[..]).unwrap(), (EXIT, vec![3]));
    }
}
