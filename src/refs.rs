use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

/// Short, stable handles (e.g. `c4k2z`) for long ids/urls so LLM output stays small.
pub struct Refs {
    state: Mutex<State>,
    file: PathBuf,
}

struct State {
    map: HashMap<String, String>,
    /// refs.tsv, opened for appending on the first new ref and kept open
    log: Option<std::fs::File>,
    /// scratch for one refs.tsv line (written with a single call)
    line: String,
}

fn fnv(s: &str) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

/// The 12 lowest base-36 digits of `n`, least significant first; a ref of length `len` uses the first `len`.
fn b36(mut n: u64) -> [u8; MAX_LEN] {
    const D: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut v = [0; MAX_LEN];
    for d in &mut v {
        *d = D[(n % 36) as usize];
        n /= 36;
    }
    v
}

const MIN_LEN: usize = 4;
const MAX_LEN: usize = 12;

impl Refs {
    pub fn load(file: PathBuf) -> Refs {
        let mut map = HashMap::new();
        if let Ok(s) = std::fs::read_to_string(&file) {
            for l in s.lines() {
                if let Some((k, v)) = l.split_once('\t') {
                    map.insert(k.to_string(), v.to_string());
                }
            }
        }
        Refs {
            state: Mutex::new(State {
                map,
                log: None,
                line: String::new(),
            }),
            file,
        }
    }

    pub fn put(&self, kind: char, full: &str) -> String {
        let mut s = String::new();
        self.put_into(kind, full, &mut s);
        s
    }

    /// `put`, appending the ref to `out` (a known ref allocates nothing).
    pub fn put_into(&self, kind: char, full: &str, out: &mut String) {
        let digits = b36(fnv(full));
        let mut buf = [0u8; 4 + MAX_LEN];
        let k = kind.encode_utf8(&mut buf).len();
        let mut st = self.state.lock().unwrap();
        let State { map, log, line } = &mut *st;
        for len in MIN_LEN..=MAX_LEN {
            buf[k..k + len].copy_from_slice(&digits[..len]);
            let key =
                std::str::from_utf8(&buf[..k + len]).expect("a char followed by base-36 digits");
            match map.get(key) {
                Some(v) if v == full => {}
                Some(_) => continue,
                None => {
                    if log.is_none() {
                        *log = std::fs::OpenOptions::new()
                            .create(true)
                            .append(true)
                            .open(&self.file)
                            .ok();
                    }
                    if let Some(f) = log {
                        line.clear();
                        line.push_str(key);
                        line.push('\t');
                        line.push_str(full);
                        line.push('\n');
                        let _ = f.write_all(line.as_bytes());
                    }
                    map.insert(key.to_string(), full.to_string());
                }
            }
            out.push_str(key);
            return;
        }
        out.push_str(full);
    }

    pub fn get(&self, token: &str) -> Option<String> {
        self.state.lock().unwrap().map.get(token).cloned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("fb-refs-{name}-{}", std::process::id()));
        let _ = std::fs::remove_file(&p);
        p
    }

    #[test]
    fn refs_are_stable_short_and_persisted() {
        let f = tmp("a");
        let r = Refs::load(f.clone());
        let a = r.put('p', "/page/posts/pfbid0abc");
        assert_eq!(a, r.put('p', "/page/posts/pfbid0abc"));
        assert!(a.starts_with('p') && a.len() == 5, "{a}");
        assert_eq!(r.get(&a).as_deref(), Some("/page/posts/pfbid0abc"));
        let again = Refs::load(f.clone());
        assert_eq!(again.get(&a).as_deref(), Some("/page/posts/pfbid0abc"));
        assert_eq!(again.get("pzzzzz"), None);
        let _ = std::fs::remove_file(f);
    }

    /// The encoding as it was before `b36` returned all digits at once.
    fn original_ref(kind: char, full: &str, len: usize) -> String {
        const D: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
        let mut n = fnv(full);
        let mut s = String::from(kind);
        for _ in 0..len {
            s.push(D[(n % 36) as usize] as char);
            n /= 36;
        }
        s
    }

    #[test]
    fn refs_keep_the_original_encoding_and_file_format() {
        let f = tmp("c");
        let r = Refs::load(f.clone());
        let urls: Vec<String> = (0..50)
            .map(|i| format!("/user.{i}/posts/pfbid0{i}"))
            .collect();
        for u in &urls {
            assert_eq!(r.put('p', u), original_ref('p', u, 4), "{u}");
        }
        assert_eq!(r.put('é', "/x"), original_ref('é', "/x", 4));
        let mut want = String::new();
        for u in &urls {
            want += &format!("{}\t{u}\n", original_ref('p', u, 4));
        }
        want += &format!("{}\t/x\n", original_ref('é', "/x", 4));
        assert_eq!(std::fs::read_to_string(&f).unwrap(), want);
        let mut out = String::from(">");
        r.put_into('p', &urls[0], &mut out);
        assert_eq!(out, format!(">{}", original_ref('p', &urls[0], 4)));
        let _ = std::fs::remove_file(f);
    }

    #[test]
    fn kinds_do_not_collide() {
        let r = Refs::load(tmp("b"));
        assert_ne!(r.put('p', "/x"), r.put('c', "/x"));
    }
}
